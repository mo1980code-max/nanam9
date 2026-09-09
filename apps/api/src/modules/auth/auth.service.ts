/**
 * Authentication: register, login, 2FA, refresh, logout, password changes.
 *
 * Security decisions, each of which answers a specific attack:
 *
 *  · IDENTICAL ERRORS for "no such user" and "wrong password", plus a dummy
 *    Argon2 verification when the user does not exist, so neither the message nor
 *    the response time reveals which usernames are registered.
 *  · PER-ACCOUNT BACKOFF on top of the IP rate limit: 8 wrong passwords for one
 *    account locks *that account* for 15 minutes. An IP limit alone does not stop
 *    a distributed attack on one admin account, and an account limit alone locks
 *    out a whole office behind one NAT.
 *  · SILENT REHASH: if a stored hash was produced with weaker parameters, a
 *    successful login rewrites it. Raising the cost of Argon2 later then requires
 *    no password reset and no migration.
 *  · TOKEN ROTATION lives in TokenService; this service only decides *when* a
 *    session may be created.
 *  · 2FA is TOTP (RFC 6238) with base32 secrets and 8 backup codes stored as
 *    SHA-256 hashes, because a backup code is a password and must not be readable
 *    from a database dump.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
// otplib 13 dropped the `authenticator` preset in favour of a functional API
// (generateSecret / generateURI / verify). Functional is better here anyway: no
// global mutable options shared across concurrent requests.
import { generateSecret as generateTotpSecret, generateURI as generateTotpUri, verify as verifyTotp } from 'otplib';
import { createHash, randomBytes } from 'node:crypto';
import { COOKIES, LIMITS, ROLE_LEVELS, TOKEN_TTL, XP, type AuthUser, type SessionPayload } from '@voltade/shared';
import type { Database, ID, SessionRow, UserRow } from '@voltade/db';
import { hashPassword, needsRehash, verifyPassword } from '@voltade/db/passwords';
import { DATABASE } from '../../common/database/database.module.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { AppError, ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '../../common/http/errors.js';
import { TokenService, type IssuedTokens } from './token.service.js';
import type { ChangePasswordDto, LoginDto, RegisterDto } from './dto/auth.dto.js';
import type { RequestUser } from '../../common/decorators/index.js';

/** Returned to the client when the password was right but 2FA is pending. */
export type TwoFactorChallenge = { twoFactorRequired: true; challengeToken: string; expiresInSeconds: number };
export type AuthResult = {
  twoFactorRequired: false;
  user: AuthUser;
  session: SessionPayload;
  /** Goes into the httpOnly refresh cookie. It is deliberately NOT part of
   *  `session`, so no controller can accidentally serialise it into a body. */
  refreshToken: string;
};

const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$Zm9vYmFyYmF6cXV1eGNvcmdl';
const CHALLENGE_TTL_SECONDS = 300;
const BACKOFF = { maxFailures: 8, windowSeconds: 900 };

type RequestMeta = { ip?: string | null; userAgent?: string | null };

@Injectable()
export class AuthService {
  private readonly logger = new Logger('auth');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
  ) {
  }

  /**
   * ±30 s of clock tolerance. A phone whose clock drifts by a minute is the single
   * most common cause of "my authenticator code does not work", and one step of
   * tolerance costs an attacker nothing (the code space is still 10^6 per window).
   */
  private static readonly TOTP_TOLERANCE_SECONDS = 30;

  // ────────────────────────────── register ──────────────────────────────

  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResult> {
    const registration = await this.settingBoolean('users.registrationEnabled', true);
    if (!registration) throw new ForbiddenError('registration is currently disabled', 'auth.registration_disabled');
    if (dto.acceptTerms === false) throw new ValidationError({ acceptTerms: ['you must accept the terms'] });

    const username = dto.username.trim();
    const email = dto.email?.trim().toLowerCase() || null;

    const problems: Record<string, string[]> = {};
    if (await this.db.identity.findUserByUsername(username)) problems.username = ['that username is taken'];
    if (email && (await this.db.identity.findUserByEmail(email))) problems.email = ['that email is already registered'];
    if (Object.keys(problems).length > 0) throw new ConflictError('auth.credentials_taken', 'some details are already in use', problems);

    const role = await this.db.identity.findRoleBySlug('user');
    if (!role) throw new AppError('server.rbac_missing', 'the role catalogue has not been seeded — run `npm run db:seed`', 500);

    const user = await this.db.identity.createUser({
      username,
      email,
      displayName: dto.displayName?.trim() || username,
      passwordHash: await hashPassword(dto.password),
      roleId: role.id,
      locale: dto.locale ?? 'ar',
      status: 'active',
      // Email verification is opt-in by configuration: a games portal that forces
      // it loses players, so we verify lazily (before payouts/profile changes).
      emailVerifiedAt: null,
      xp: 0,
      level: 1,
    });

    await this.log(user.id, user.username, 'auth.register', 'user', user.id, meta);
    await this.db.engagement.notify({
      userId: user.id,
      kind: 'system',
      title: 'أهلًا بك في Voltade',
      body: 'حسابك جاهز — ابدأ بلعبة، واجمع النقاط لتفتح الشارات.',
      link: '/games',
    });

    return this.finishLogin(user, meta, true);
  }

  // ─────────────────────────────── login ────────────────────────────────

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthResult | TwoFactorChallenge> {
    const login = dto.login.trim();
    const backoffKey = `auth:fail:${login.toLowerCase()}`;
    const failures = Number((await this.redis.get(backoffKey)) ?? '0');
    if (failures >= BACKOFF.maxFailures) {
      const ttl = await this.redis.increment(backoffKey, BACKOFF.windowSeconds);
      throw new AppError('auth.too_many_attempts', `too many failed attempts for this account — try again in ${ttl.ttlSeconds}s`, 429, {
        retryAfterSeconds: ttl.ttlSeconds,
      });
    }

    const credentials = await this.db.identity.findUserCredentials(login);
    if (!credentials) {
      // Spend the same time a real verification would, so response latency does
      // not become a username oracle.
      await verifyPassword(DUMMY_HASH, dto.password);
      await this.recordFailure(backoffKey);
      throw new UnauthorizedError('incorrect username or password', 'auth.invalid_credentials');
    }

    const ok = await verifyPassword(credentials.passwordHash, dto.password);
    if (!ok) {
      await this.recordFailure(backoffKey);
      await this.log(null, login, 'auth.login_failed', 'user', credentials.id, meta);
      throw new UnauthorizedError('incorrect username or password', 'auth.invalid_credentials');
    }
    if (credentials.deletedAt) throw new UnauthorizedError('account no longer exists', 'auth.account_missing');
    if (credentials.status === 'banned') {
      await this.log(credentials.id, credentials.username, 'auth.login_blocked', 'user', credentials.id, meta);
      throw new ForbiddenError('this account is suspended', 'auth.account_banned');
    }

    await this.redis.del(backoffKey);

    // Argon2 parameters can be raised without ever forcing a reset.
    if (credentials.passwordHash && needsRehash(credentials.passwordHash)) {
      await this.db.identity.updateUser(credentials.id, { passwordHash: await hashPassword(dto.password) });
      this.logger.log(`rehashed the password of ${credentials.username} with current Argon2 parameters`);
    }

    if (credentials.twoFactorEnabled && credentials.twoFactorSecret) {
      if (!dto.code) return this.startChallenge(credentials);
      const verified = await this.verifyTwoFactor(credentials, dto.code);
      if (!verified) {
        await this.recordFailure(backoffKey);
        throw new UnauthorizedError('incorrect two-factor code', 'auth.invalid_2fa');
      }
    }

    await this.db.identity.touchLogin(credentials.id, meta.ip ?? null);
    return this.finishLogin(credentials, meta, false);
  }

  /** Second step of a 2FA login: exchange the challenge token for a session. */
  async completeTwoFactor(challengeToken: string, code: string, meta: RequestMeta): Promise<AuthResult> {
    const raw = await this.redis.get(`auth:2fa:${challengeToken}`);
    if (!raw) throw new UnauthorizedError('the two-factor challenge expired — sign in again', 'auth.challenge_expired');
    const userId = raw as ID;

    const user = await this.db.identity.findUserById(userId, true);
    if (!user || !user.twoFactorSecret) throw new UnauthorizedError('account is not signed in', 'auth.invalid_credentials');

    const ok = (await this.verifyTotpCode(user.twoFactorSecret!, code)) || (await this.consumeBackupCode(user, code));
    if (!ok) throw new UnauthorizedError('incorrect two-factor code', 'auth.invalid_2fa');

    await this.redis.del(`auth:2fa:${challengeToken}`);
    await this.db.identity.touchLogin(user.id, meta.ip ?? null);
    return this.finishLogin(user, meta, false);
  }

  private startChallenge(user: UserRow): TwoFactorChallenge {
    const challengeToken = randomBytes(24).toString('base64url');
    void this.redis.set(`auth:2fa:${challengeToken}`, user.id, CHALLENGE_TTL_SECONDS);
    return { twoFactorRequired: true, challengeToken, expiresInSeconds: CHALLENGE_TTL_SECONDS };
  }

  private async recordFailure(key: string): Promise<void> {
    await this.redis.increment(key, BACKOFF.windowSeconds);
  }

  /** Issues tokens, awards the daily-login XP once per day, logs the event. */
  private async finishLogin(user: UserRow, meta: RequestMeta, isNewAccount: boolean): Promise<AuthResult> {
    const issued: IssuedTokens = await this.tokens.issue(user, meta);
    await this.log(user.id, user.username, isNewAccount ? 'auth.register' : 'auth.login', 'user', user.id, meta);

    if (!isNewAccount) await this.awardDailyLogin(user);

    const authUser = await this.tokens.toAuthUser(user);
    return {
      twoFactorRequired: false,
      user: authUser,
      session: { user: authUser, accessToken: issued.accessToken, expiresAt: issued.expiresAt.toISOString() },
      refreshToken: issued.refreshToken,
    };
  }

  /** +10 XP the first time an account logs in on a given UTC day. */
  private async awardDailyLogin(user: UserRow): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `xp:daily-login:${user.id}:${day}`;
    if (await this.redis.get(key)) return;
    await this.redis.set(key, '1', 48 * 3600);
    await this.db.engagement.awardXp({ userId: user.id, amount: XP.dailyLogin, reason: 'auth.daily_login', targetKind: 'user', targetId: user.id });
  }

  // ─────────────────────────────── session ──────────────────────────────

  async refresh(refreshToken: string, meta: RequestMeta): Promise<{ session: SessionPayload; refreshToken: string }> {
    const issued = await this.tokens.refresh(refreshToken, meta);
    const authUser = await this.tokens.toAuthUser(issued.user);
    return {
      session: { user: authUser, accessToken: issued.accessToken, expiresAt: issued.expiresAt.toISOString() },
      refreshToken: issued.refreshToken,
    };
  }

  async logout(refreshToken: string | null | undefined, user: RequestUser | null, meta: RequestMeta): Promise<{ revoked: boolean }> {
    let revoked = false;
    if (refreshToken) revoked = await this.tokens.revoke(refreshToken);
    if (user) await this.log(user.id, user.username, 'auth.logout', 'user', user.id, meta);
    return { revoked };
  }

  async me(user: RequestUser): Promise<AuthUser> {
    const row = await this.db.identity.findUserById(user.id, true);
    if (!row) throw new UnauthorizedError('account no longer exists', 'auth.account_missing');
    return this.tokens.toAuthUser(row);
  }

  async listSessions(user: RequestUser): Promise<{ id: ID; kind: string; userAgent: string | null; ip: string | null; createdAt: Date; expiresAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }[]> {
    const rows: SessionRow[] = await this.db.identity.listSessions(user.id);
    return rows
      .filter((s) => !s.revokedAt && s.expiresAt.getTime() > Date.now())
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        lastUsedAt: s.lastUsedAt,
        revokedAt: s.revokedAt,
      }));
  }

  async revokeSession(user: RequestUser, sessionId: ID): Promise<{ revoked: boolean }> {
    const rows = await this.db.identity.listSessions(user.id);
    const owned = rows.some((s) => s.id === sessionId);
    // Ownership check first: a session id is not a secret, so `DELETE /sessions/:id`
    // must not become a way to log other people out.
    if (!owned) throw new ForbiddenError('that session does not belong to you', 'auth.session_not_owned');
    return { revoked: await this.db.identity.revokeSession(sessionId) };
  }

  async revokeEverywhere(user: RequestUser): Promise<{ revoked: number }> {
    return { revoked: await this.tokens.revokeAllFor(user.id) };
  }

  // ─────────────────────────────── password ─────────────────────────────

  async changePassword(user: RequestUser, dto: ChangePasswordDto, meta: RequestMeta): Promise<{ changed: boolean; revokedSessions: number }> {
    const credentials = await this.db.identity.findUserCredentials(user.username);
    if (!credentials?.passwordHash || !(await verifyPassword(credentials.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedError('the current password is incorrect', 'auth.invalid_credentials');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new ValidationError({ newPassword: ['the new password must be different'] });
    }

    await this.db.identity.updateUser(user.id, { passwordHash: await hashPassword(dto.newPassword) });
    const revoked = dto.revokeOthers === false ? 0 : await this.tokens.revokeAllFor(user.id);
    await this.log(user.id, user.username, 'auth.password_changed', 'user', user.id, meta);
    await this.db.engagement.notify({
      userId: user.id,
      kind: 'system',
      title: 'تم تغيير كلمة المرور',
      body: revoked > 0 ? `تم تسجيل الخروج من ${revoked} جهاز آخر.` : 'تم تغيير كلمة المرور بنجاح.',
      link: '/me/security',
    });
    return { changed: true, revokedSessions: revoked };
  }

  // ──────────────────────────────── 2FA ─────────────────────────────────

  async setupTwoFactor(user: RequestUser): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string; backupCodes: string[] }> {
    const row = await this.db.identity.findUserById(user.id);
    if (!row) throw new UnauthorizedError();
    if (row.twoFactorEnabled) throw new ConflictError('auth.2fa_already_enabled', 'two-factor authentication is already enabled');

    const secret = generateTotpSecret({ length: 20 });
    const otpauthUrl = generateTotpUri({ issuer: 'Voltade', label: row.email ?? `${row.username}@voltade`, secret });

    // Backup codes are generated now and shown once; only their hashes are stored.
    const backupCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    await this.db.identity.updateUser(user.id, {
      twoFactorSecret: secret,
      twoFactorBackupCodes: backupCodes.map((c) => AuthService.hashBackupCode(c)),
    });

    let qrCodeDataUrl = '';
    try {
      // Imported lazily: `qrcode` pulls in a canvas dependency we do not want on
      // the hot path of every login.
      const { toDataURL } = await import('qrcode');
      qrCodeDataUrl = await toDataURL(otpauthUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    } catch (error) {
      this.logger.warn(`could not render the 2FA QR code: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { secret, otpauthUrl, qrCodeDataUrl, backupCodes };
  }

  async enableTwoFactor(user: RequestUser, code: string): Promise<{ enabled: boolean }> {
    const row = await this.db.identity.findUserById(user.id);
    if (!row?.twoFactorSecret) throw new ConflictError('auth.2fa_not_started', 'call /auth/2fa/setup first');
    if (!(await this.verifyTotpCode(row.twoFactorSecret, code))) {
      throw new ValidationError({ code: ['that code is not valid — check your device clock'] });
    }
    await this.db.identity.updateUser(user.id, { twoFactorEnabled: true });
    await this.tokens.revokeAllFor(user.id);
    return { enabled: true };
  }

  async disableTwoFactor(user: RequestUser, password: string): Promise<{ disabled: boolean }> {
    const credentials = await this.db.identity.findUserCredentials(user.username);
    if (!credentials?.passwordHash || !(await verifyPassword(credentials.passwordHash, password))) {
      throw new UnauthorizedError('the password is incorrect', 'auth.invalid_credentials');
    }
    await this.db.identity.updateUser(user.id, { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] });
    return { disabled: true };
  }

  /** Backup codes are single-use: consuming one removes it from the stored list. */
  private async consumeBackupCode(user: UserRow, code: string): Promise<boolean> {
    const hash = AuthService.hashBackupCode(code.replace(/[^a-z0-9]/gi, '').toLowerCase());
    const codes = user.twoFactorBackupCodes ?? [];
    const index = codes.indexOf(hash);
    if (index === -1) return false;
    const remaining = codes.filter((_, i) => i !== index);
    await this.db.identity.updateUser(user.id, { twoFactorBackupCodes: remaining });
    await this.db.engagement.notify({
      userId: user.id,
      kind: 'system',
      title: 'تم استخدام رمز استرداد',
      body: `تبقّى ${remaining.length} من رموز الاسترداد. إن لم تكن أنت، غيّر كلمة المرور فورًا.`,
      link: '/me/security',
    });
    return true;
  }

  private async verifyTwoFactor(user: UserRow, code: string): Promise<boolean> {
    const cleaned = code.trim();
    if (/^\d{6}$/.test(cleaned)) return user.twoFactorSecret ? this.verifyTotpCode(user.twoFactorSecret, cleaned) : false;
    return this.consumeBackupCode(user, cleaned);
  }

  /** One TOTP check. otplib compares in constant time; we only add tolerance. */
  private async verifyTotpCode(secret: string, token: string): Promise<boolean> {
    try {
      const result = await verifyTotp({ secret, token, epochTolerance: AuthService.TOTP_TOLERANCE_SECONDS });
      return result.valid === true;
    } catch {
      return false;
    }
  }

  static hashBackupCode(code: string): string {
    return createHash('sha256').update(code.replace(/[^a-z0-9]/gi, '').toLowerCase()).digest('hex');
  }

  // ─────────────────────────────── helpers ──────────────────────────────

  /** Cookie flags the controller uses; kept here so the policy lives in one file. */
  cookiePolicy() {
    return {
      access: {
        name: COOKIES.accessToken,
        maxAgeSeconds: this.config.JWT_ACCESS_TTL_SECONDS ?? TOKEN_TTL.accessSeconds,
        httpOnly: true,
      },
      refresh: {
        name: COOKIES.refreshToken,
        maxAgeSeconds: this.config.REFRESH_TTL_SECONDS ?? TOKEN_TTL.refreshSeconds,
        httpOnly: true,
      },
    };
  }

  async settingBoolean(key: string, fallback: boolean): Promise<boolean> {
    const row = await this.db.operations.getSetting(key);
    return typeof row?.value === 'boolean' ? row.value : fallback;
  }

  private async log(actorId: ID | null, actorLabel: string, action: string, targetKind: string, targetId: ID | null, meta: RequestMeta): Promise<void> {
    await this.db.operations.logActivity({
      actorId,
      actorLabel,
      action,
      targetKind,
      targetId,
      ip: meta.ip ?? null,
      userAgent: (meta.userAgent ?? null)?.slice(0, 400) ?? null,
    });
  }

  /** Used by the admin impersonation route (super admin only). */
  async impersonate(admin: RequestUser, targetId: ID, meta: RequestMeta): Promise<AuthResult> {
    if (admin.role.level < ROLE_LEVELS['super-admin']) throw new ForbiddenError('only a super admin may impersonate', 'auth.impersonation_denied');
    const target = await this.db.identity.findUserById(targetId, true);
    if (!target) throw new UnauthorizedError('that account does not exist', 'user.not_found');
    await this.log(admin.id, admin.username, 'auth.impersonate', 'user', target.id, meta);
    return this.finishLogin(target, meta, false);
  }
}
