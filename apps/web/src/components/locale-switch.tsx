'use client';

/**
 * The language toggle — one link that does two jobs.
 *
 * 1. It swaps the leading URL segment (/ar/games → /en/games), so the visitor keeps
 *    their place in the site instead of being dumped on the homepage.
 * 2. It writes the `voltade_locale` cookie, which is what the middleware reads the next
 *    time an *unprefixed* URL arrives (an old bookmark, a shared link, a crawler-less
 *    deep link): the human's explicit choice beats the Accept-Language guess forever.
 *
 * A client component because it needs the current pathname; everything around it in the
 * header stays server-rendered.
 */

import { usePathname } from 'next/navigation';
import { LOCALE_COOKIE, t, type Locale } from '@/lib/i18n';

export function LocaleSwitch({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const other: Locale = locale === 'ar' ? 'en' : 'ar';

  // /ar/games?x → /en/games?x (usePathname drops the query; preserving it is not
  // worth the extra state — the language switch landing on the same page is the point).
  const target = `/${other}${pathname.replace(new RegExp(`^/${locale}`), '') || ''}` || `/${other}`;

  return (
    <a
      href={target}
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE}=${other}; path=/; max-age=31536000; samesite=lax`;
      }}
      className="btn btn-ghost !px-3 text-xs font-black"
      title={t(locale, 'lang.aria')}
      aria-label={t(locale, 'lang.aria')}
      lang={other}
    >
      <span aria-hidden>🌐</span>
      <span className="hidden sm:inline">{t(locale, 'lang.switch')}</span>
    </a>
  );
}
