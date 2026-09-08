/**
 * Site footer — server component.
 *
 * It is built from the same data the navigation uses (categories, published CMS pages)
 * rather than a hardcoded list of links, so a page created in the admin panel appears
 * in the footer without a deploy. Internal links in a footer are also how a crawler
 * discovers the pages that nothing else points at — which is why every one of them
 * carries the locale prefix here.
 */

import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import type { Category } from '@/lib/api';
import { l, pick, t, type Locale } from '@/lib/i18n';

type Props = {
  locale: Locale;
  siteName: string;
  tagline: string;
  categories: Category[];
  pages: { slug: string; title: string; titleEn?: string | null; url: string }[];
};

export function SiteFooter({ locale, siteName, tagline, categories, pages }: Props) {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-line bg-surface/60">
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="mb-3 flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-lg text-white">
              <span aria-hidden>⚡</span>
            </span>
            <span className="text-lg font-black text-ink">{siteName}</span>
          </div>
          <p className="mb-4 max-w-xs text-sm leading-7 text-muted">{tagline}</p>
          <div className="flex items-center gap-2">
            <ThemeToggle locale={locale} />
            <Link href={l(locale, '/blog')} className="btn btn-ghost !px-3" aria-label={t(locale, 'footer.blogAria')}>📝</Link>
          </div>
        </div>

        <nav aria-label={t(locale, 'footer.categories')}>
          <h2 className="mb-3 text-sm font-black text-ink">{t(locale, 'footer.categories')}</h2>
          <ul className="grid gap-2">
            {categories.slice(0, 8).map((category) => (
              <li key={category.id}>
                <Link
                  href={category.url ? l(locale, category.url) : l(locale, `/category/${category.slug}`)}
                  className="text-sm text-muted transition-colors hover:text-brand"
                >
                  {category.icon ? `${category.icon} ` : ''}
                  {pick(locale, category.name, category.nameEn)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label={t(locale, 'footer.site')}>
          <h2 className="mb-3 text-sm font-black text-ink">{t(locale, 'footer.site')}</h2>
          <ul className="grid gap-2">
            <li><Link href={l(locale, '/games')} className="text-sm text-muted transition-colors hover:text-brand">{t(locale, 'nav.allGames')}</Link></li>
            <li><Link href={l(locale, '/search')} className="text-sm text-muted transition-colors hover:text-brand">{t(locale, 'nav.search')}</Link></li>
            <li><Link href={l(locale, '/blog')} className="text-sm text-muted transition-colors hover:text-brand">{t(locale, 'nav.blog')}</Link></li>
            <li><Link href={l(locale, '/leaderboard')} className="text-sm text-muted transition-colors hover:text-brand">{t(locale, 'nav.leaderboard')}</Link></li>
            {pages.map((page) => (
              <li key={page.slug}>
                <Link href={l(locale, page.url)} className="text-sm text-muted transition-colors hover:text-brand">
                  {pick(locale, page.title, page.titleEn)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <h2 className="mb-3 text-sm font-black text-ink">{t(locale, 'footer.why', { site: siteName })}</h2>
          <ul className="grid gap-2 text-sm text-muted">
            <li>{t(locale, 'footer.why1')}</li>
            <li>{t(locale, 'footer.why2')}</li>
            <li>{t(locale, 'footer.why3')}</li>
            <li>{t(locale, 'footer.why4')}</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-line px-4 py-5">
        <p className="mx-auto max-w-7xl text-center text-xs text-muted">{t(locale, 'footer.rights', { year, site: siteName })}</p>
      </div>
    </footer>
  );
}
