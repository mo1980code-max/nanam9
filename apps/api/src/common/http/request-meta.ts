/**
 * Request metadata: the context a service needs but should not have to dig out of
 * an Express request itself.
 *
 * WHY PASS IT EXPLICITLY INSTEAD OF AsyncLocalStorage: implicit context is how
 * services end up logging `undefined` actors in background jobs (there is no request
 * there), and how a queue worker silently writes audit lines attributed to nobody.
 * A parameter the compiler checks cannot be forgotten — and the same service method
 * works identically from an HTTP handler, a cron job, or a test.
 */

import type { Request } from 'express';
import type { Locale } from '@voltade/shared';
import type { AuditContext } from '../audit/audit.service.js';
import { resolveLocale } from './urls.js';
import type { AuthenticatedRequest } from '../decorators/index.js';

export type RequestMeta = AuditContext & {
  locale: Locale;
  playSessionId?: string | null;
  referer?: string | null;
  /** CF-IPCountry / x-vercel-ip-country when a proxy provides it. Never trusted from the client. */
  country?: string | null;
  requestId?: string | null;
};

export function requestMeta(req: Request, options: { defaultLocale?: Locale } = {}): RequestMeta {
  const request = req as AuthenticatedRequest;
  const user = request.user;
  const countryHeader = req.headers['cf-ipcountry'] ?? req.headers['x-vercel-ip-country'] ?? req.headers['x-country'];
  return {
    actorId: user?.id ?? null,
    actorLabel: user?.username ?? null,
    ip: request.clientIp ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    locale: user?.locale === 'en' || user?.locale === 'ar' ? user.locale : resolveLocale(req, options.defaultLocale ?? 'ar'),
    playSessionId: request.playSessionId ?? null,
    referer: (req.headers.referer as string | undefined) ?? null,
    country: typeof countryHeader === 'string' && /^[a-zA-Z-]{2,8}$/.test(countryHeader) ? countryHeader.toUpperCase() : null,
    requestId: request.requestId ?? null,
  };
}

/** Metadata for work that has no HTTP request: cron jobs, queue workers, CLI. */
export function systemMeta(label = 'system'): RequestMeta {
  return { actorId: null, actorLabel: label, ip: null, userAgent: null, locale: 'ar', requestId: null };
}
