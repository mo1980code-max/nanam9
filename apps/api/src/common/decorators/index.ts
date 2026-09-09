/**
 * The decorators the API is written with.
 *
 * Metadata keys are symbols-in-strings so the guards can read them with
 * `Reflector`, which is the idiomatic (and testable) Nest way: the rule is
 * declared next to the handler, not buried in a service.
 */

import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Permission, RoleSlug } from '@voltade/shared';

export const IS_PUBLIC_KEY = 'voltade:public';
export const PERMISSIONS_KEY = 'voltade:permissions';
export const ROLES_KEY = 'voltade:roles';
export const RATE_LIMIT_KEY = 'voltade:rate-limit';
export const PERMISSION_MODE_KEY = 'voltade:permission-mode';

/** Skips authentication for a handler or a whole controller (health, sitemap, public catalogue). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Requires every listed permission (`AND`). Use `AnyPermission` for `OR`.
 * `@Permissions('games.publish')` reads better in a controller than a role check
 * and survives a role being renamed or a new role being added.
 */
export const Permissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const AnyPermission = (...permissions: Permission[]) => [
  SetMetadata(PERMISSIONS_KEY, permissions),
  SetMetadata(PERMISSION_MODE_KEY, 'any'),
];

/** Coarse check by role level: `@Roles('admin')` means level >= admin. */
export const Roles = (...roles: RoleSlug[]) => SetMetadata(ROLES_KEY, roles);

/** Which rate-limit bucket a handler draws from (see RATE_LIMITS in @voltade/shared). */
export type RateLimitBucket = 'global' | 'auth' | 'login' | 'write' | 'comment' | 'play' | 'search' | 'import' | 'admin';
export const RateLimit = (bucket: RateLimitBucket) => SetMetadata(RATE_LIMIT_KEY, bucket);

export type RequestUser = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string;
  roleId: string;
  role: { slug: string; name: string; level: number };
  permissions: string[];
  xp: number;
  level: number;
  premium: boolean;
  twoFactorEnabled: boolean;
  status: string;
};

export type AuthenticatedRequest = Request & {
  user?: RequestUser;
  /** Anonymous play-session id (cookie `voltade_sid`) — set for guests too. */
  playSessionId?: string;
  requestId?: string;
  clientIp?: string;
};

/** `@CurrentUser()` → the authenticated user, or null on a @Public route. */
export const CurrentUser = createParamDecorator((field: keyof RequestUser | undefined, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  const user = request.user ?? null;
  if (!user || !field) return user;
  return user[field];
});

/** `@CurrentUserOrThrow()` — for handlers that are @Public but behave better logged in. */
export const OptionalUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().user ?? null;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.clientIp ?? request.ip ?? '0.0.0.0';
});

export const PlaySession = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().playSessionId;
});

export const RequestId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().requestId ?? '-';
});
