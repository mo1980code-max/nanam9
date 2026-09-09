/**
 * Authentication guard (global).
 *
 * Where the token comes from, in order:
 *  1. the `voltade_at` httpOnly cookie — the browser path, and the only one the
 *     Next.js app uses;
 *  2. `Authorization: Bearer …` — for API clients and for a future mobile app.
 *
 * On a @Public route an invalid or missing token is not an error: the handler
 * runs with `req.user = null`, which is how the catalogue serves both guests and
 * logged-in players (favourites, "you rated this") from one endpoint.
 *
 * The guard verifies the JWT signature and then loads the user row. That second
 * step costs one indexed query per authenticated request and buys something a
 * pure-JWT design cannot: a ban, a role change or a deleted account takes effect
 * immediately, not 15 minutes later when the token expires.
 */

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COOKIES } from '@voltade/shared';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, type AuthenticatedRequest, type RequestUser } from '../decorators/index.js';
import { TokenService } from '../../modules/auth/token.service.js';
import { UnauthorizedError } from '../http/errors.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractToken(request);

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedError('sign in to continue');
    }

    const payload = await this.tokens.verifyAccess(token);
    if (!payload) {
      if (isPublic) return true;
      // 401 (not 403) with an explicit code so the client knows to call /auth/refresh.
      throw new UnauthorizedError('session expired, refresh required', 'auth.token_expired');
    }

    const user = await this.tokens.userForPayload(payload);
    request.user = toRequestUser(user, await this.tokens.permissionsFor(user.roleId));
    return true;
  }
}

function extractToken(req: Request): string | null {
  const cookie = req.cookies?.[COOKIES.accessToken];
  if (typeof cookie === 'string' && cookie.length > 20) return cookie;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
}

function toRequestUser(user: import('@voltade/db').UserRow, permissions: string[]): RequestUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    roleId: user.roleId,
    role: user.role
      ? { slug: user.role.slug, name: user.role.name, level: user.role.level }
      : { slug: 'user', name: 'User', level: 20 },
    permissions,
    xp: user.xp,
    level: user.level,
    // Not resolved here on purpose: `isPremium` is a join against subscriptions,
    // and paying it on every request to serve a thumbnail would be silly. The
    // endpoints that actually gate on it (ad-free rendering, premium games) call
    // PremiumService, and /auth/me returns the authoritative value.
    premium: user.premium ?? false,
    twoFactorEnabled: user.twoFactorEnabled,
    status: user.status,
  };
}
