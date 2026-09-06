/**
 * OAuth sign-in: Google, Facebook, Discord — without Passport.
 *
 * WHY NO PASSPORT: three providers, one authorization-code flow each. Passport
 * would add a strategy package per provider, its own session abstraction and a
 * layer of callbacks, to save ~40 lines each. Writing the flow directly means the
 * state parameter, the redirect URI and the profile mapping are all visible in one
 * file, which is exactly what you want when a provider changes its API (they do).
 *
 * The flow:
 *   GET  /auth/oauth/:provider          → 302 to the provider with a `state`
 *   GET  /auth/oauth/:provider/callback → verify `state`, exchange the code,
 *                                         find-or-create the account, issue our
 *                                         own tokens, 302 back into the web app.
 *
 * `state` is stored in an httpOnly cookie rather than in Redis so a multi-replica
 * deployment needs no shared store for sign-in to work.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Database, ID } from '@voltade/db';
import { slugify } from '@voltade/shared';
import { DATABASE } from '../../common/database/database.module.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { AppError, ForbiddenError, UnauthorizedError } from '../../common/http/errors.js';
import { TokenService, type IssuedTokens } from './token.service.js';

export type OAuthProfile = {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
};

type ProviderSpec = {
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  /** Extra authorize-query parameters (Facebook's `auth_type`, Discord's prompt). */
  extra?: Record<string, string>;
};

const PROVIDERS: Record<string, ProviderSpec> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    extra: { access_type: 'online', prompt: 'select_account' },
  },
  facebook: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    userUrl: 'https://graph.facebook.com/me?fields=id,name,email,picture.width(200)',
    scope: 'email public_profile',
  },
  discord: {
    authorizeUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userUrl: 'https://discord.com/api/users/@me',
    scope: 'identify email',
    extra: { prompt: 'none' },
  },
};

export const OAUTH_STATE_COOKIE = 'voltade_oauth_state';

@Injectable()
export class OauthService {
  private readonly logger = new Logger('oauth');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
  ) {}

  isEnabled(provider: string): boolean {
    const spec = this.spec(provider);
    const creds = this.credentials(provider);
    return Boolean(spec && creds.id && creds.secret);
  }

  listEnabled(): { provider: string; enabled: boolean }[] {
    return Object.keys(PROVIDERS).map((provider) => ({ provider, enabled: this.isEnabled(provider) }));
  }

  /** The provider's authorize URL plus the `state` value to store in the cookie. */
  buildAuthorizeUrl(provider: string, redirectUri: string, returnTo?: string): { url: string; state: string } {
    this.spec(provider);
    const { id } = this.credentials(provider);
    if (!id) throw new AppError(`oauth.${provider}.disabled`, `${provider} sign-in is not configured`, 501);

    const state = randomBytes(24).toString('base64url');
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: PROVIDERS[provider]!.scope,
      state,
      ...PROVIDERS[provider]!.extra,
    });
    // `returnTo` rides inside the state cookie, never in the provider's URL: an
    // open redirect through the sign-in flow is a phishing gift.
    void returnTo;
    return { url: `${PROVIDERS[provider]!.authorizeUrl}?${params.toString()}`, state };
  }

  /** Verifies the code and returns the account + our own tokens. */
  async handleCallback(
    provider: string,
    code: string,
    redirectUri: string,
    meta: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ tokens: IssuedTokens; userId: ID; username: string; isNew: boolean }> {
    this.spec(provider);
    const profile = await this.exchange(provider, code, redirectUri);

    const existingLink = await this.db.identity.findOAuthAccount(provider, profile.providerUserId);
    let userId = existingLink?.userId ?? null;
    let isNew = false;

    if (!userId && profile.email) {
      // An account with the same verified email already exists: link rather than
      // create a duplicate. Unverified emails are NOT trusted for linking — that
      // is how an attacker would take over an account.
      const byEmail = await this.db.identity.findUserByEmail(profile.email);
      if (byEmail && profile.emailVerified) userId = byEmail.id;
    }

    if (!userId) {
      const role = await this.db.identity.findRoleBySlug('user');
      if (!role) throw new AppError('server.rbac_missing', 'the role catalogue has not been seeded', 500);
      const username = await this.uniqueUsername(profile.name ?? profile.email ?? provider);
      const created = await this.db.identity.createUser({
        username,
        email: profile.email,
        displayName: profile.name ?? username,
        avatarUrl: profile.avatarUrl,
        // No password: this account signs in through the provider. A password can
        // be added later from the profile screen ("set a password").
        passwordHash: null,
        roleId: role.id,
        locale: 'ar',
        status: 'active',
        emailVerifiedAt: profile.emailVerified ? new Date() : null,
      });
      userId = created.id;
      isNew = true;
    }

    const user = await this.db.identity.findUserById(userId, true);
    if (!user) throw new UnauthorizedError('account could not be loaded', 'auth.account_missing');
    if (user.status === 'banned') throw new ForbiddenError('this account is suspended', 'auth.account_banned');

    await this.db.identity.upsertOAuthAccount({
      userId: user.id,
      provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      accessToken: profile.accessToken,
      refreshToken: profile.refreshToken,
      tokenExpiresAt: profile.expiresAt,
    });

    const tokens = await this.tokens.issue(user, meta);
    await this.db.identity.touchLogin(user.id, meta.ip ?? null);
    await this.db.operations.logActivity({
      actorId: user.id,
      actorLabel: user.username,
      action: isNew ? 'auth.oauth_register' : 'auth.oauth_login',
      targetKind: 'user',
      targetId: user.id,
      after: { provider },
      ip: meta.ip ?? null,
      userAgent: (meta.userAgent ?? null)?.slice(0, 400) ?? null,
    });

    return { tokens, userId: user.id, username: user.username, isNew };
  }

  /** Removes a linked provider. Refuses to leave an account with no way in. */
  async unlink(user: { id: ID; username: string }, provider: string): Promise<{ unlinked: boolean }> {
    const accounts = await this.db.identity.findOAuthAccountsForUser(user.id);
    const credentials = await this.db.identity.findUserCredentials(user.username);
    const hasPassword = Boolean(credentials?.passwordHash);
    if (accounts.length <= 1 && !hasPassword) {
      throw new AppError(
        'oauth.cannot_unlink_last',
        'this is your only sign-in method — set a password first',
        409,
      );
    }
    const target = accounts.find((a) => a.provider === provider);
    if (!target) return { unlinked: false };
    await this.db.identity.deleteOAuthAccount(target.id);
    return { unlinked: true };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private spec(provider: string): ProviderSpec {
    const spec = PROVIDERS[provider];
    if (!spec) throw new AppError('oauth.unknown_provider', `unknown provider "${provider}"`, 404);
    return spec;
  }

  private credentials(provider: string): { id?: string; secret?: string } {
    switch (provider) {
      case 'google': return { id: this.config.OAUTH_GOOGLE_ID, secret: this.config.OAUTH_GOOGLE_SECRET };
      case 'facebook': return { id: this.config.OAUTH_FACEBOOK_ID, secret: this.config.OAUTH_FACEBOOK_SECRET };
      case 'discord': return { id: this.config.OAUTH_DISCORD_ID, secret: this.config.OAUTH_DISCORD_SECRET };
      default: return {};
    }
  }

  private async exchange(provider: string, code: string, redirectUri: string): Promise<OAuthProfile> {
    const { id, secret } = this.credentials(provider);
    if (!id || !secret) throw new AppError(`oauth.${provider}.disabled`, `${provider} sign-in is not configured`, 501);

    const body = new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch(PROVIDERS[provider]!.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      this.logger.warn(`${provider} token exchange failed: ${tokenResponse.status} ${detail.slice(0, 300)}`);
      throw new AppError('oauth.token_exchange_failed', 'the provider rejected the sign-in attempt', 502);
    }
    const tokenJson = (await tokenResponse.json()) as Record<string, unknown>;
    const accessToken = String(tokenJson.access_token ?? '');
    if (!accessToken) throw new AppError('oauth.no_access_token', 'the provider returned no access token', 502);

    const userResponse = await fetch(PROVIDERS[provider]!.userUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) throw new AppError('oauth.profile_failed', 'could not read your profile from the provider', 502);
    const profile = (await userResponse.json()) as Record<string, unknown>;

    return this.mapProfile(provider, profile, accessToken, tokenJson);
  }

  /** Each provider names things differently; this is the whole reason for the file. */
  private mapProfile(provider: string, p: Record<string, unknown>, accessToken: string, tokenJson: Record<string, unknown>): OAuthProfile {
    const expiresIn = Number(tokenJson.expires_in ?? 0);
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;
    const refreshToken = tokenJson.refresh_token ? String(tokenJson.refresh_token) : null;

    if (provider === 'google') {
      return {
        providerUserId: String(p.sub ?? ''),
        email: p.email ? String(p.email).toLowerCase() : null,
        emailVerified: p.email_verified === true || p.email_verified === 'true',
        name: p.name ? String(p.name) : null,
        avatarUrl: p.picture ? String(p.picture) : null,
        accessToken,
        refreshToken,
        expiresAt,
      };
    }
    if (provider === 'facebook') {
      const picture = (p.picture as { data?: { url?: string } } | undefined)?.data?.url ?? null;
      return {
        providerUserId: String(p.id ?? ''),
        email: p.email ? String(p.email).toLowerCase() : null,
        // Facebook only returns an email it has already verified.
        emailVerified: Boolean(p.email),
        name: p.name ? String(p.name) : null,
        avatarUrl: picture,
        accessToken,
        refreshToken,
        expiresAt,
      };
    }
    const avatar =
      p.avatar && p.id
        ? `https://cdn.discordapp.com/avatars/${String(p.id)}/${String(p.avatar)}.png?size=200`
        : null;
    return {
      providerUserId: String(p.id ?? ''),
      email: p.email ? String(p.email).toLowerCase() : null,
      emailVerified: p.verified === true || p.email !== undefined,
      name: p.global_name ? String(p.global_name) : p.username ? String(p.username) : null,
      avatarUrl: avatar,
      accessToken,
      refreshToken,
      expiresAt,
    };
  }

  /** `john.doe@gmail.com` → `john_doe`, `john_doe_4821` if taken. */
  private async uniqueUsername(seed: string): Promise<string> {
    const base = slugify(seed.split('@')[0] ?? seed, { max: 24 }).replace(/[^a-z0-9_.-]/gi, '') || 'player';
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = attempt === 0 ? base : `${base}_${Math.floor(Math.random() * 9000 + 1000)}`;
      if (!(await this.db.identity.findUserByUsername(candidate))) return candidate;
    }
    return `player_${randomBytes(3).toString('hex')}`;
  }
}
