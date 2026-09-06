/**
 * Token lifecycle: short-lived access JWT + rotating refresh token.
 *
 * THE DESIGN, and why it is not "just a JWT for 30 days":
 *  · The ACCESS token is a signed JWT with a 15-minute life. It is verified
 *    without touching the database, which is what keeps the game pages fast under
 *    load. It lives in an httpOnly cookie, so no XSS can read it.
 *  · The REFRESH token is 48 random bytes whose SHA-256 hash is stored in the
 *    `sessions` table. It is *rotated on every use*: the old row is revoked and a
 *    new one is issued. Rotation is what makes a long life (30 days) acceptable —
 *    a stolen token works at most once, and presenting an already-revoked token
 *    is treated as theft, revoking every session of that user.
 *  · Only the hash is stored. A database leak therefore does not hand over
 *    working sessions, which is the same reason passwords are Argon2id hashes.
 *
 * The API is the only component that issues or verifies tokens. The Next.js app
 * never sees a secret: it forwards cookies.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { COOKIES, TOKEN_TTL, type AuthUser } from '@voltade/shared';
import { DATABASE } from '../../common/database/database.module.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { UnauthorizedError } from '../../common/http/errors.js';
import type { Database, ID, UserRow } from '@voltade/db';

type AccessPayload = {
  sub: string;
  usr: string;
  role: string;
  lvl: number;
  sid: string;
};

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  sessionId: ID;
};

/** A refresh also hands back the user it validated: the caller would otherwise
 *  query for it again, and a second query is a second chance to disagree. */
export type RefreshResult = IssuedTokens & { user: UserRow };

@Injectable()
export class TokenService {
  private readonly logger = new Logger('auth');
  /** role id → permissions, cached briefly: RBAC changes are rare, and this
   *  removes one join per authenticated request. */
  private readonly permissionCache = new Map<string, { permissions: string[]; at: number }>();
  private static readonly PERMISSION_TTL_MS = 60_000;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static newRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /** Issues an access+refresh pair and persists the refresh token's hash. */
  async issue(user: UserRow, meta: { userAgent?: string | null; ip?: string | null } = {}): Promise<IssuedTokens> {
    const refreshToken = TokenService.newRefreshToken();
    const expiresAt = new Date(Date.now() + (this.config.REFRESH_TTL_SECONDS ?? TOKEN_TTL.refreshSeconds) * 1000);

    const session = await this.db.identity.createSession({
      userId: user.id,
      tokenHash: TokenService.hashToken(refreshToken),
      kind: 'refresh',
      userAgent: (meta.userAgent ?? null)?.slice(0, 400),
      ip: meta.ip ?? null,
      expiresAt,
    });

    const accessToken = await this.signAccess(user, session.id);
    return { accessToken, refreshToken, expiresAt: new Date(Date.now() + this.accessTtlSeconds() * 1000), sessionId: session.id };
  }

  accessTtlSeconds(): number {
    return this.config.JWT_ACCESS_TTL_SECONDS ?? TOKEN_TTL.accessSeconds;
  }

  async signAccess(user: UserRow, sessionId: ID): Promise<string> {
    const role = user.role ?? (await this.roleOf(user.roleId));
    const payload: AccessPayload = {
      sub: user.id,
      usr: user.username,
      role: role?.slug ?? 'user',
      lvl: role?.level ?? 20,
      sid: sessionId,
    };
    return this.jwt.signAsync(payload, { expiresIn: this.accessTtlSeconds() });
  }

  async verifyAccess(token: string): Promise<AccessPayload | null> {
    try {
      const payload = await this.jwt.verifyAsync<AccessPayload>(token);
      if (!payload?.sub) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Exchanges a refresh token for a new pair, rotating it.
   * Reusing an already-rotated token revokes every session for that user: that is
   * the standard theft signal, and the cost of a false positive is one re-login.
   */
  async refresh(refreshToken: string, meta: { userAgent?: string | null; ip?: string | null } = {}): Promise<RefreshResult> {
    const hash = TokenService.hashToken(refreshToken);
    const session = await this.db.identity.findSessionByHash(hash);

    if (!session) throw new UnauthorizedError('invalid refresh token', 'auth.invalid_token');
    if (session.revokedAt) {
      this.logger.warn(`refresh-token reuse detected for user ${session.userId} — revoking all sessions`);
      await this.db.identity.revokeSessionsForUser(session.userId);
      throw new UnauthorizedError('refresh token reuse detected; all sessions were revoked', 'auth.token_reuse');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.db.identity.revokeSession(session.id);
      throw new UnauthorizedError('refresh token expired', 'auth.token_expired');
    }

    const user = await this.db.identity.findUserById(session.userId, true);
    if (!user || user.status === 'banned' || user.deletedAt) {
      await this.db.identity.revokeSession(session.id);
      throw new UnauthorizedError('account is not active', 'auth.account_inactive');
    }

    await this.db.identity.revokeSession(session.id);
    const issued = await this.issue(user, meta);
    return { ...issued, user };
  }

  async revoke(refreshToken: string): Promise<boolean> {
    const session = await this.db.identity.findSessionByHash(TokenService.hashToken(refreshToken));
    return session ? this.db.identity.revokeSession(session.id) : false;
  }

  async revokeAllFor(userId: ID, exceptSessionId?: ID): Promise<number> {
    return this.db.identity.revokeSessionsForUser(userId, exceptSessionId);
  }

  /** Builds the `AuthUser` the frontend receives: role, permissions, premium. */
  async toAuthUser(user: UserRow): Promise<AuthUser> {
    const role = user.role ?? (await this.roleOf(user.roleId));
    const [permissions, premium] = await Promise.all([this.permissionsFor(user.roleId), this.db.commerce.isPremium(user.id)]);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      role: { slug: role?.slug ?? 'user', name: role?.name ?? 'User', level: role?.level ?? 20 },
      permissions,
      xp: user.xp,
      level: user.level,
      premium,
      twoFactorEnabled: user.twoFactorEnabled,
    };
  }

  /** Loads a user for an access-token payload, refusing anything not active. */
  async userForPayload(payload: AccessPayload): Promise<UserRow> {
    const user = await this.db.identity.findUserById(payload.sub, true);
    if (!user || user.deletedAt) throw new UnauthorizedError('account no longer exists', 'auth.account_missing');
    if (user.status === 'banned') throw new UnauthorizedError('account is suspended', 'auth.account_banned');
    return user;
  }

  private async roleOf(roleId: ID): Promise<{ id: ID; slug: string; name: string; level: number } | null> {
    const roles = await this.db.identity.listRoles();
    return roles.find((r) => r.id === roleId) ?? null;
  }

  /** Cached role → permission lookup; `*` is materialised at seed/sync time. */
  async permissionsFor(roleId: ID): Promise<string[]> {
    const cached = this.permissionCache.get(roleId);
    if (cached && Date.now() - cached.at < TokenService.PERMISSION_TTL_MS) return cached.permissions;
    const permissions = await this.db.identity.permissionsForRoleIds([roleId]);
    this.permissionCache.set(roleId, { permissions, at: Date.now() });
    return permissions;
  }

  /** Called after any RBAC edit so the change is visible within one request. */
  invalidatePermissionCache(): void {
    this.permissionCache.clear();
  }

  /** Constant-time compare, for the 2FA code and any API-token check. */
  static safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}

/** Cookie options in one place — the flags are the security policy. */
export function cookieOptions(config: AppConfig, { maxAgeSeconds, httpOnly = true }: { maxAgeSeconds?: number; httpOnly?: boolean }) {
  return {
    httpOnly,
    secure: config.COOKIE_SECURE || config.isProduction,
    // Lax, not None: the API and the web app share a registrable domain, and Lax
    // still blocks cross-site POSTs from carrying the cookie (CSRF's main vector).
    sameSite: 'lax' as const,
    path: '/',
    domain: config.COOKIE_DOMAIN || undefined,
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds * 1000 } : {}),
  };
}

export const ACCESS_COOKIE = COOKIES.accessToken;
export const REFRESH_COOKIE = COOKIES.refreshToken;
