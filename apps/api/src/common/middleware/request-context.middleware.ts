/**
 * Request context middleware: the three things every handler may need and no
 * handler should have to compute.
 *
 *  · requestId — from `x-request-id` (a proxy/CDN usually sets one) or generated.
 *    It is echoed back on every response and stamped on 5xx bodies, so a support
 *    ticket that quotes an id can be traced through the logs.
 *  · clientIp — `trust proxy` is on because the API sits behind Cloudflare and
 *    Next.js; without it every rate-limit bucket collapses onto the proxy's IP.
 *  · playSessionId — the anonymous cookie that gives guests "continue playing"
 *    and gives the stats a unique-visitor key without any personal data.
 */

import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { COOKIES } from '@voltade/shared';
import { CONFIG, type AppConfig } from '../../config/env.js';
import type { AuthenticatedRequest } from '../decorators/index.js';

const PLAY_SESSION_TTL_DAYS = 90;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const request = req as AuthenticatedRequest;

    request.requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    res.setHeader('x-request-id', request.requestId);

    request.clientIp = pickIp(req, this.config.TRUST_PROXY);

    let sid = req.cookies?.[COOKIES.playSession] as string | undefined;
    if (!sid || !/^[a-zA-Z0-9_-]{16,64}$/.test(sid)) {
      sid = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16);
      res.cookie(COOKIES.playSession, sid, {
        httpOnly: false, // the client reads it to correlate its own analytics events
        secure: this.config.COOKIE_SECURE || this.config.isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: PLAY_SESSION_TTL_DAYS * 86_400_000,
        domain: this.config.COOKIE_DOMAIN || undefined,
      });
    }
    request.playSessionId = sid;

    // A conservative baseline. The security middleware tightens these and the
    // per-route policies (ads, embedded games) relax exactly what they must.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');

    next();
  }
}

/** `req.ip` is only correct when Express is told to trust the proxy chain. */
function pickIp(req: Request, trustProxy: boolean): string {
  if (!trustProxy) return req.socket.remoteAddress ?? '0.0.0.0';
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    // First entry is the client; the rest are proxies that appended themselves.
    return forwarded.split(',')[0]!.trim();
  }
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf.trim();
  return req.ip ?? req.socket.remoteAddress ?? '0.0.0.0';
}
