/**
 * Breadcrumbs. Rendered from the `trail` the API returns, so the visible links and the
 * BreadcrumbList JSON-LD are generated from one source and cannot disagree — a mismatch
 * between the two is a rich-result warning in Search Console and nothing else.
 */

import Link from 'next/link';

export function Breadcrumbs({ trail }: { trail: { name: string; url: string }[] }) {
  if (!trail?.length) return null;
  return (
    <nav aria-label="مسار التنقل" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <li>
          <Link href="/" className="transition-colors hover:text-brand">الرئيسية</Link>
        </li>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.url}-${index}`} className="flex items-center gap-1.5">
              <span aria-hidden className="opacity-50">/</span>
              {last ? (
                <span aria-current="page" className="font-bold text-ink">{crumb.name}</span>
              ) : (
                <Link href={crumb.url} className="transition-colors hover:text-brand">{crumb.name}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
