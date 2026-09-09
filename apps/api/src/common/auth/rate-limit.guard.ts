/**
 * Rate limiting (global).
 *
 * WHY NOT @nestjs/throttler: version 6 is not compatible with NestJS 12, and its
 * tracker is per-process. A portal behind Cloudflare needs one counter shared by
 * every replica, so the bucket lives in Redis — with the in-process fallback from
 * RedisService for a single-node dev box.
 *
 * Fixed window (INCR + EXPIRE) rather than a sliding log: one Redis round trip per
 * request, and the worst case is a burst of 2× the limit at a window boundary,
 * which is acceptable for everything except login — and login gets the tightest
 * limit in the product (8 per 5 minutes) plus a per-account counter in AuthService.
 *
 * The key includes the user id when authenticated, so a NAT'd office full of
 * players does not share one bucket, and one abusive script cannot lock out a
 * whole ISP.
 */

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMITS } from '@voltade/shared';
import type { Request } from 'express';
import { RATE_LIMIT_KEY, type AuthenticatedRequest, type RateLimitBucket } from '../decorators/index.js';
import { RedisService } from '../redis/redis.service.js';
import { ThrottledError } from '../http/errors.js';
import { CONFIG, type AppConfig } from '../../config/env.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket =
      this.reflector.getAllAndOverride<RateLimitBucket>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]) ?? 'global';
    const limit = RATE_LIMITS[bucket] ?? RATE_LIMITS.global;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = request.user?.id ?? request.clientIp ?? request.ip ?? 'anonymous';
    const key = `rl:${bucket}:${identity}`;

    const { count, ttlSeconds } = await this.redis.increment(key, limit.windowSeconds);

    // Standard headers, so a well-behaved client can back off without parsing JSON.
    const res = context.switchToHttp().getResponse<{ setHeader?: (k: string, v: string | number) => void }>();
    res.setHeader?.('x-ratelimit-limit', String(limit.max));
    res.setHeader?.('x-ratelimit-remaining', String(Math.max(0, limit.max - count)));
    res.setHeader?.('x-ratelimit-reset', String(ttlSeconds));

    if (count > limit.max) {
      if (!this.config.isProduction) {
        // eslint-disable-next-line no-console
        console.warn(`rate limit hit: ${bucket} ${identity} (${count}/${limit.max}) ${request.method} ${request.url}`);
      }
      throw new ThrottledError(ttlSeconds);
    }
    return true;
  }
}

/** Exposed for the tests and for admin tooling that wants to clear a bucket. */
export async function clearRateLimit(redis: RedisService, bucket: string, identity: string): Promise<void> {
  await redis.del(`rl:${bucket}:${identity}`);
}

export type { Request };
