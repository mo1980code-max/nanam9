/**
 * /[locale]/search — the server-rendered results page.
 *
 * The header's instant search covers the "I know roughly what I want" case; this page
 * covers the shared-link and SEO case. Results pages stay noindex (thin by nature) but
 * the hreflang cluster still tells Google which language sibling exists.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GameGrid } from '@/components/game-card';
import { Pagination } from '@/components/pagination';
import { SearchBox } from '@/components/search-box';
import { getCategories, getSettings, listGames, settingValue, siteUrl } from '@/lib/api';
import { isLocale, l, localeAlternates, n, pick, t, type Locale } from '@/lib/i18n';

// Results depend entirely on the query string; each combination caches separately.
export const revalidate = 30;

type Params = { locale: string };
type Query = { q?: string; page?: string };

export async function generateMetadata({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Query> }): Promise<Metadata> {
  const { locale: raw } = await params;
  const { q } = await searchParams;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  const term = (q ?? '').trim();
  return {
    title: term ? t(locale, 'search.resultsFor', { term }) : t(locale, 'search.resultsTitle'),
    description: term ? t(locale, 'search.resultsFor', { term }) : t(locale, 'search.descDefault'),
    alternates: localeAlternates(locale, '/search'),
    // Search-result pages are thin by nature; keep them out of the index so they never
    // compete with the category pages for the same queries.
    robots: { index: false, follow: true },
    openGraph: { type: 'website', title: t(locale, 'search.resultsTitle'), url: siteUrl(l(locale, '/search')) },
  };
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const query = await searchParams;
  const term = (query.q ?? '').trim();
  const page = Math.max(1, Number(query.page) || 1);

  const [settings, categories] = await Promise.all([getSettings(), getCategories()]);
  const perPage = Number(settingValue(settings, 'games.perPage', 24)) || 24;
  const result = term ? await listGames({ q: term, page, perPage, sort: 'popular' }) : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <nav aria-label={t(locale, 'crumbs.aria')} className="mb-3 text-xs text-muted">
        <Link href={l(locale, '/')} className="hover:text-brand">{t(locale, 'crumbs.home')}</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <span className="font-bold text-ink">{t(locale, 'nav.search')}</span>
      </nav>

      <h1 className="mb-5 text-2xl font-black text-ink sm:text-3xl">
        {term ? t(locale, 'search.resultsFor', { term }) : t(locale, 'search.findHeading')}
      </h1>

      <div className="mb-7">
        <SearchBox locale={locale} variant="page" initialValue={term} autoFocus={!term} />
      </div>

      {term && result && result.items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-3 text-4xl" aria-hidden>🤷</p>
          <h2 className="mb-2 text-lg font-black text-ink">{t(locale, 'search.notFoundTitle', { term })}</h2>
          <p className="mb-6 max-w-md text-sm leading-8 text-muted">{t(locale, 'search.notFoundBody')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {categories.slice(0, 8).map((category) => (
              <Link key={category.id} href={l(locale, `/category/${category.slug}`)} className="chip">
                <span aria-hidden>{category.icon ?? '•'}</span>
                {pick(locale, category.name, category.nameEn)}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {result && result.items.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-muted">{t(locale, 'search.resultsCount', { count: n(locale, result.total) })}</p>
          <GameGrid games={result.items} locale={locale} />
          <Pagination
            page={page}
            totalPages={result.totalPages}
            hrefFor={(target) => l(locale, `/search?q=${encodeURIComponent(term)}&page=${target}`)}
            locale={locale}
          />
        </>
      ) : null}

      {!term ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="card p-5">
            <h2 className="mb-2 text-sm font-black text-ink">{t(locale, 'search.quickCats')}</h2>
            <div className="flex flex-wrap gap-2">
              {categories.slice(0, 12).map((category) => (
                <Link key={category.id} href={l(locale, `/category/${category.slug}`)} className="chip">
                  <span aria-hidden>{category.icon ?? '•'}</span>
                  {pick(locale, category.name, category.nameEn)}
                </Link>
              ))}
            </div>
          </div>
          <div className="card p-5">
            <h2 className="mb-2 text-sm font-black text-ink">{t(locale, 'search.howTo')}</h2>
            <p className="text-sm leading-8 text-muted">
              {t(locale, 'search.howToBody')}{' '}
              <Link href={l(locale, '/games')} className="font-bold text-brand hover:underline">{t(locale, 'nav.allGames')}</Link>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
