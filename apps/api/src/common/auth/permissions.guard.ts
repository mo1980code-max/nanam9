/**
 * Authorization guard (global, runs after AuthGuard).
 *
 * Two ways to declare a rule, and when to use which:
 *  · `@Permissions('games.publish')` — the normal case. Permissions are stable;
 *    roles are how we group them. Adding an "Editor" tier later means editing the
 *    RBAC table, not every controller.
 *  · `@Roles('admin')` — for the handful of routes whose meaning is the *rank*
 *    itself (impersonation, role management), where "level >= admin" is the rule.
 *
 * Super admin short-circuits on level, not on a permission list: the seeded list
 * is materialised for reporting, but the guard must never depend on that
 * materialisation being complete.
 *
 * A missing permission is a 403 with the permission name in the code, so the UI
 * can hide the button instead of showing an error after the click.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_LEVELS, type RoleSlug } from '@voltade/shared';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, PERMISSION_MODE_KEY, ROLES_KEY, type AuthenticatedRequest } from '../decorators/index.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Mutable array on purpose: Reflector's overload set rejects `as const`.
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const roles = this.reflector.getAllAndOverride<RoleSlug[]>(ROLES_KEY, targets) ?? [];
    if (required.length === 0 && roles.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) throw new UnauthorizedError('sign in to continue');

    // Rank short-circuit: super admin (level 100) and admin (80) outrank any
    // permission list, which is what `@Roles('admin')` means.
    const level = user.role.level;
    if (roles.length > 0) {
      const needed = Math.min(...roles.map((r) => ROLE_LEVELS[r] ?? Number.MAX_SAFE_INTEGER));
      if (level < needed) throw new ForbiddenError(`requires role ${roles.join(' or ')}`, 'auth.role_required');
    }

    if (required.length > 0 && level < ROLE_LEVELS['super-admin']) {
      const has = user.permissions.includes('*')
        ? true
        : this.reflector.getAllAndOverride<'all' | 'any'>(PERMISSION_MODE_KEY, targets) === 'any'
          ? required.some((p) => user.permissions.includes(p) || user.permissions.includes(wildcardOf(p)))
          : required.every((p) => user.permissions.includes(p) || user.permissions.includes(wildcardOf(p)));
      if (!has) throw new ForbiddenError(`missing permission: ${required.join(', ')}`, `auth.missing_permission.${required[0]}`);
    }

    return true;
  }
}

/** `games.publish` → `games.*`, so a role granted a whole module matches. */
function wildcardOf(permission: string): string {
  const dot = permission.indexOf('.');
  return dot > 0 ? `${permission.slice(0, dot)}.*` : '*';
}
