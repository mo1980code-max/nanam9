/**
 * Pagination as real links, not buttons.
 *
 * Every page must be reachable by a crawler without executing JavaScript, which means
 * an <a href> with the page number in the query string. A "load more" button that
 * fetches on click leaves pages 2..N out of the index.
 *
 * `hrefFor` is supplied by the page and already contains the locale prefix.
 */

import Link from 'next/link';
import { n, t, type Locale } from '@/lib/i18n';

type Props = {
  page: number;
  totalPages: number;
  /** Builds the href for a page number; keeps the caller's filters in the URL. */
  hrefFor: (page: number) => string;
  locale?: Locale;
};

export function Pagination({ page, totalPages, hrefFor, locale = 'ar' }: Props) {
  if (totalPages <= 1) return null;

  const window: number[] = [];
  const from = Math.max(1, page - 2);
  const to = Math.min(totalPages, from + 4);
  for (let index = Math.max(1, to - 4); index <= to; index += 1) window.push(index);

  return (
    <nav aria-label={t(locale, 'pager.aria')} className="mt-8 flex flex-wrap items-center justify-center gap-1.5">
      {page > 1 && (
        <Link href={hrefFor(page - 1)} className="btn btn-ghost !px-3" rel="prev">{t(locale, 'pager.prev')}</Link>
      )}
      {window[0]! > 1 && (
        <>
          <Link href={hrefFor(1)} className="btn btn-ghost !min-w-10 !px-3">{n(locale, 1)}</Link>
          {window[0]! > 2 && <span className="px-1 text-muted">…</span>}
        </>
      )}
      {window.map((number) => (
        <Link
          key={number}
          href={hrefFor(number)}
          aria-current={number === page ? 'page' : undefined}
          className={`btn !min-w-10 !px-3 ${number === page ? 'btn-primary' : 'btn-ghost'}`}
        >
          {n(locale, number)}
        </Link>
      ))}
      {window[window.length - 1]! < totalPages && (
        <>
          {window[window.length - 1]! < totalPages - 1 && <span className="px-1 text-muted">…</span>}
          <Link href={hrefFor(totalPages)} className="btn btn-ghost !min-w-10 !px-3">
            {n(locale, totalPages)}
          </Link>
        </>
      )}
      {page < totalPages && (
        <Link href={hrefFor(page + 1)} className="btn btn-ghost !px-3" rel="next">{t(locale, 'pager.next')}</Link>
      )}
    </nav>
  );
}
