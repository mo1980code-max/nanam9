/**
 * CSRF guard (global) — double-submit cookie.
 *
 * The access token lives in an httpOnly cookie, which stops XSS from stealing it
 * but makes the browser attach it automatically to *any* request to our origin.
 * That is the definition of a CSRF surface, so every state-changing request must
 * also carry a value an attacker's cross-site form cannot read: the `voltade_csrf`
 * cookie is deliberately readable by our own JavaScript and must be echoed back in
 * the `x-csrf-token` header.
 *
 * Exemptions, each for a stated reason:
 *  · safe methods (GET/HEAD/OPTIONS) — they must not change state anyway;
 *  · `Authorization: Bearer` requests — a header an attacker cannot set
 *    cross-site, so there is no ambient credential to abuse;
 *  · routes marked @CsrfExempt that verify their own signature (Stripe webhooks).
 *    Opting out is explicit, so it shows up in a code review.
 */

import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, SetMetadata, type NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { COOKIES } from '@voltade/shared';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { AppError } from '../http/errors.js';

export const CSRF_EXEMPT_KEY = 'voltade:csrf-exempt';
export const CSRF_COOKIE = 'voltade_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Marks a webhook route as signature-verified instead of cookie-verified. */
export const CsrfExempt = () => SetMetadata(CSRF_EXEMPT_KEY, true);

export class CsrfError extends AppError {
  constructor() {
    super('csrf.token_mismatch', 'the CSRF token is missing or does not match — reload the page and try again', HttpStatus.FORBIDDEN);
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.CSRF_ENABLED) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT_KEY, [context.getHandler(), context.getClass()])) return true;
    if (request.headers.authorization?.startsWith('Bearer ')) return true;

    // No session cookie → no ambient credential → nothing to forge.
    const hasSessionCookie = Boolean(request.cookies?.[COOKIES.accessToken] || request.cookies?.[COOKIES.refreshToken]);
    if (!hasSessionCookie) return true;

    const expected = request.cookies?.[CSRF_COOKIE];
    const provided = headerOf(request, CSRF_HEADER);
    if (!expected || !provided || !safeEqual(expected, provided)) throw new CsrfError();
    return true;
  }
}

/** Issues the readable CSRF cookie on any request that does not have one yet. */
export class CsrfCookieMiddleware implements NestMiddleware {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (this.config.CSRF_ENABLED) {
      const existing = req.cookies?.[CSRF_COOKIE];
      if (!existing || existing.length < 32) {
        res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
          httpOnly: false, // the whole point: our own JavaScript must be able to read it
          secure: this.config.COOKIE_SECURE || this.config.isProduction,
          sameSite: 'lax',
          path: '/',
          domain: this.config.COOKIE_DOMAIN || undefined,
          maxAge: 7 * 86_400_000,
        });
      }
    }
    next();
  }
}

function headerOf(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
