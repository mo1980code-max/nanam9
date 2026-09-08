/**
 * Breadcrumbs. Rendered from the `trail` the API returns, so the visible links and the
 * BreadcrumbList JSON-LD are generated from one source and cannot disagree — a mismatch
 * between the two is a rich-result warning in Search Console and nothing else.
 *
 * The API stores trail URLs unprefixed (/category/x); `l()` adds the locale so the
 * visible trail and the JSON-LD (which callers build from the same trail) stay aligned.
 */

import Link from 'next/link';
import { l, t, type Locale } from '@/lib/i18n';

export function Breadcrumbs({ trail, locale = 'ar' }: { trail: { name: string; url: string }[]; locale?: Locale }) {
  if (!trail?.length) return null;
  return (
    <nav aria-label={t(locale, 'crumbs.aria')} className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <li>
          <Link href={l(locale, '/')} className="transition-colors hover:text-brand">{t(locale, 'crumbs.home')}</Link>
        </li>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.url}-${index}`} className="flex items-center gap-1.5">
              <span aria-hidden className="opacity-50">/</span>
              {last ? (
                <span aria-current="page" className="font-bold text-ink">{crumb.name}</span>
              ) : (
                <Link href={l(locale, crumb.url)} className="transition-colors hover:text-brand">{crumb.name}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
