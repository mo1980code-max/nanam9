'use client';

/**
 * The portal 404 — a client component on purpose.
 *
 * notFound() gives us no params, so the locale is read from the URL the visitor is
 * actually on (usePathname): /en/whatever-not-here must render the ENGLISH 404 with
 * links that keep the /en prefix. The middleware guarantees an unprefixed path never
 * reaches here.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isLocale, l, t, type Locale } from '@/lib/i18n';

export default function NotFound() {
  const pathname = usePathname();
  const first = pathname.split('/')[1] ?? '';
  const locale: Locale = isLocale(first) ? first : 'ar';

  return (
    <div className="mx-auto grid w-full max-w-2xl place-items-center px-4 py-24 text-center">
      <p className="mb-4 text-6xl" aria-hidden>🕹️</p>
      <h1 className="mb-3 text-3xl font-black text-ink">{t(locale, 'notFound.title')}</h1>
      <p className="mb-7 text-sm leading-8 text-muted">{t(locale, 'notFound.body')}</p>
      <div className="flex flex-wrap justify-center gap-2.5">
        <Link href={l(locale, '/')} className="btn btn-primary">{t(locale, 'notFound.home')}</Link>
        <Link href={l(locale, '/games')} className="btn btn-ghost">{t(locale, 'notFound.games')}</Link>
        <Link href={l(locale, '/search')} className="btn btn-ghost">{t(locale, 'notFound.search')}</Link>
      </div>
    </div>
  );
}
