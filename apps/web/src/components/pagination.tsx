/**
 * Pagination as real links, not buttons.
 *
 * Every page must be reachable by a crawler without executing JavaScript, which means
 * an <a href> with the page number in the query string. A "load more" button that
 * fetches on click leaves pages 2..N out of the index — for a portal whose whole value
 * proposition is SEO at 20,000 games, that is the difference between being found and
 * not being found.
 */

import Link from 'next/link';

type Props = {
  page: number;
  totalPages: number;
  /** Builds the href for a page number; keeps the caller's filters in the URL. */
  hrefFor: (page: number) => string;
  label?: string;
};

export function Pagination({ page, totalPages, hrefFor, label = 'التنقل بين الصفحات' }: Props) {
  if (totalPages <= 1) return null;

  const window: number[] = [];
  const from = Math.max(1, page - 2);
  const to = Math.min(totalPages, from + 4);
  for (let index = Math.max(1, to - 4); index <= to; index += 1) window.push(index);

  return (
    <nav aria-label={label} className="mt-8 flex flex-wrap items-center justify-center gap-1.5">
      {page > 1 && (
        <Link href={hrefFor(page - 1)} className="btn btn-ghost !px-3" rel="prev">السابق</Link>
      )}
      {window[0]! > 1 && (
        <>
          <Link href={hrefFor(1)} className="btn btn-ghost !min-w-10 !px-3">١</Link>
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
          {number.toLocaleString('ar-EG')}
        </Link>
      ))}
      {window[window.length - 1]! < totalPages && (
        <>
          {window[window.length - 1]! < totalPages - 1 && <span className="px-1 text-muted">…</span>}
          <Link href={hrefFor(totalPages)} className="btn btn-ghost !min-w-10 !px-3">
            {totalPages.toLocaleString('ar-EG')}
          </Link>
        </>
      )}
      {page < totalPages && (
        <Link href={hrefFor(page + 1)} className="btn btn-ghost !px-3" rel="next">التالي</Link>
      )}
    </nav>
  );
}
