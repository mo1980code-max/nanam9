/**
 * URL + locale resolution for HTTP handlers.
 *
 * WHY ABSOLUTE URLS LEAVE THE API: stored paths are relative (`/media/games/…`,
 * `games/abc/index.html`) so moving storage to a CDN is a config change, not a
 * data migration. But a browser rendering an <img> from a Next.js page on another
 * origin cannot resolve a relative path against the API — so the API resolves it
 * once, here, against the configured base. One place, one rule, no client guessing.
 *
 * WHY LOCALE IS RESOLVED SERVER-SIDE: the same URL must render Arabic or English
 * depending on the visitor, and crawlers need `?lang=en` to work without cookies.
 * Precedence is explicit: query → cookie → Accept-Language → site default. Anything
 * else produces the classic bug where SSR and the client disagree and the page
 * flickers between languages.
 */

import type { Request } from 'express';
import { LOCALES, type Locale } from '@voltade/shared';

export function absoluteUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value;
  const cleanBase = base.replace(/\/$/, '');
  return value.startsWith('/') ? `${cleanBase}${value}` : `${cleanBase}/${value}`;
}

export function resolveLocale(req: Request | undefined, fallback: Locale = 'ar'): Locale {
  if (!req) return fallback;
  const query = req.query?.lang ?? req.query?.locale;
  const fromQuery = typeof query === 'string' ? query.toLowerCase() : undefined;
  if (fromQuery && (LOCALES as readonly string[]).includes(fromQuery)) return fromQuery as Locale;

  const cookieValue = req.cookies?.['NEXT_LOCALE'] ?? req.cookies?.['voltade_locale'];
  if (typeof cookieValue === 'string' && (LOCALES as readonly string[]).includes(cookieValue.toLowerCase())) {
    return cookieValue.toLowerCase() as Locale;
  }

  const accept = req.headers?.['accept-language'];
  if (typeof accept === 'string') {
    // "ar,en;q=0.9" → the first tag we support wins; q-values below 0.1 are ignored.
    for (const part of accept.split(',')) {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      if (q && Number(q.slice(2)) < 0.1) continue;
      const code = (tag ?? '').toLowerCase().slice(0, 2);
      if ((LOCALES as readonly string[]).includes(code)) return code as Locale;
    }
  }
  return fallback;
}

/** Prefer the localised value, then the other language, then the raw fallback. */
export function localized(ar: string | null | undefined, en: string | null | undefined, locale: Locale): string | null {
  const primary = locale === 'ar' ? ar : en;
  const secondary = locale === 'ar' ? en : ar;
  return (primary?.trim() ? primary : secondary?.trim() ? secondary : null) ?? null;
}
