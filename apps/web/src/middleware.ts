/**
 * Locale routing middleware — the front door of the bilingual site.
 *
 * Every rendered page lives under /ar/… or /en/…. This middleware is what makes the
 * old unprefixed URLs (and every link out there in the wild) keep working: it picks a
 * locale and redirects.
 *
 * The choice order is deliberate:
 *   1. the visitor's explicit switch (the `voltade_locale` cookie the language toggle
 *      sets) — a human choice always beats a guess;
 *   2. Accept-Language — first visit, so guess from the browser;
 *   3. Arabic — the portal's default and primary audience.
 *
 * 307 (temporary) on purpose: the "right" target depends on the visitor's cookie, so a
 * permanent 301 would let caches pin one language for everyone. SEO is handled where it
 * belongs — canonical + hreflang on the locale pages themselves — not by this redirect.
 *
 * WHAT IS EXCLUDED (the matcher): the API proxy, the admin panel (operators' language
 * is a panel setting, not a URL), Next internals, anything with a file extension, and
 * /games/<slug>/… which are the PLAYABLE GAME ASSETS in public/ — redirecting those
 * would break every iframe on the site. Note the careful split: exact `/games` is a
 * route (redirect it), `/games/…` is an asset directory (never touch it).
 */

import { NextRequest, NextResponse } from 'next/server';

const LOCALES = ['ar', 'en'];
const LOCALE_COOKIE = 'voltade_locale';

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const first = pathname.split('/')[1] ?? '';
  if (LOCALES.includes(first)) return NextResponse.next();

  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  const accept = request.headers.get('accept-language') ?? '';
  const locale = LOCALES.includes(cookie ?? '') ? cookie! : accept.toLowerCase().startsWith('en') ? 'en' : 'ar';

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  url.search = search;
  return NextResponse.redirect(url, 307);
}

export const config = {
  // Match everything EXCEPT: api, admin, _next internals, files with an extension,
  // asset directories, and /games/<anything> (playable assets). Bare /games is matched.
  matcher: ['/games', '/((?!api|admin|_next|games/|icons|brand|uploads|games-assets|.*\\..*).*)'],
};
