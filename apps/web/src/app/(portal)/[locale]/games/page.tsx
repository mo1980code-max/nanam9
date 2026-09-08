/**
 * /[locale]/games — the full catalogue.
 *
 * Every filter is a query parameter, so every filtered view is a shareable, indexable
 * URL and works with the back button. The page is ISR with a short window; each
 * distinct (locale, query) pair gets its own cache entry — which is exactly how a
 * 20 000-game bilingual catalogue stays cheap to serve.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GameGrid } from '@/components/game-card';
import { Pagination } from '@/components/pagination';
import { SearchBox } from '@/components/search-box';
import { GAME_SORTS, getCategories, getSettings, getTags, listGames, settingValue, siteUrl } from '@/lib/api';
import { isLocale, l, localeAlternates, n, pick, t, type Locale, type MessageKey } from '@/lib/i18n';

export const revalidate = 30;

/** Typed bridge between the API's sort vocabulary and the dictionary. */
const SORT_LABEL_KEYS: Record<string, MessageKey> = {
  newest: 'games.sort.newest',
  popular: 'games.sort.popular',
  top_rated: 'games.sort.top_rated',
  most_liked: 'games.sort.most_liked',
  trending: 'games.sort.trending',
  random: 'games.sort.random',
  az: 'games.sort.az',
  updated: 'games.sort.updated',
};

type Params = { locale: string };
type Query = { page?: string; sort?: string; category?: string; tag?: string; q?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  return {
    title: t(locale, 'games.heading'),
    description: t(locale, 'games.description'),
    alternates: localeAlternates(locale, '/games'),
    openGraph: { type: 'website', title: t(locale, 'games.heading'), url: siteUrl(l(locale, '/games')) },
  };
}

/** Every chip rewrites the query and drops the page number: changing a filter returns you to page 1. */
function chipHref(locale: Locale, base: Query, patch: Partial<Query>) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...patch })) {
    if (value && key !== 'page') next[key] = value;
  }
  const search = new URLSearchParams(next).toString();
  return l(locale, search ? `/games?${search}` : '/games');
}

export default async function GamesPage({
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
  const page = Math.max(1, Number(query.page) || 1);
  const sort = (GAME_SORTS as readonly string[]).includes(query.sort ?? '') ? query.sort! : 'newest';

  const settings = await getSettings();
  const perPage = Number(settingValue(settings, 'games.perPage', 24)) || 24;
  const [categories, tags, result] = await Promise.all([
    getCategories(),
    getTags(28),
    listGames({
      page,
      perPage,
      sort,
      category: query.category || undefined,
      tag: query.tag || undefined,
      q: query.q || undefined,
    }),
  ]);

  const totalPages = result.totalPages;
  const activeCategory = query.category;
  const activeTag = query.tag;
  const foundCategory = activeCategory ? categories.find((category) => category.slug === activeCategory) : undefined;
  const heading = activeCategory
    ? foundCategory
      ? pick(locale, foundCategory.name, foundCategory.nameEn)
      : t(locale, 'games.categoryHeading', { slug: activeCategory })
    : activeTag
      ? t(locale, 'games.tagHeading', { name: tags.find((tag) => tag.slug === activeTag)?.name ?? activeTag })
      : query.q
        ? t(locale, 'search.resultsFor', { term: query.q })
        : t(locale, 'games.heading');

  const hrefFor = (target: number) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) if (value && key !== 'page') next[key] = value;
    next.page = String(target);
    return l(locale, `/games?${new URLSearchParams(next).toString()}`);
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_300px] lg:items-start">
        <div>
          <nav aria-label={t(locale, 'crumbs.aria')} className="mb-2 text-xs text-muted">
            <Link href={l(locale, '/')} className="hover:text-brand">{t(locale, 'crumbs.home')}</Link>
            <span aria-hidden className="mx-1.5">/</span>
            <span className="font-bold text-ink">{t(locale, 'nav.games')}</span>
          </nav>
          <h1 className="mb-1 text-2xl font-black text-ink sm:text-3xl">{heading}</h1>
          <p className="text-sm text-muted">{t(locale, 'games.countLine', { count: n(locale, result.total) })}</p>
        </div>
        <SearchBox locale={locale} variant="page" initialValue={query.q ?? ''} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t(locale, 'games.sortAria')}>
        <span className="text-xs font-bold text-muted">{t(locale, 'games.sortBy')}</span>
        {GAME_SORTS.map((value) => (
          <Link
            key={value}
            href={chipHref(locale, query, { sort: value })}
            aria-current={sort === value ? 'true' : undefined}
            className={`chip ${sort === value ? 'chip-active' : ''}`}
          >
            {SORT_LABEL_KEYS[value] ? t(locale, SORT_LABEL_KEYS[value]!) : value}
          </Link>
        ))}
      </div>

      {(activeCategory || activeTag || query.q) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {activeCategory ? (
            <Link href={chipHref(locale, query, { category: undefined })} className="chip chip-active">
              {t(locale, 'games.filterCategory')} {activeCategory} <span aria-hidden>✕</span>
            </Link>
          ) : null}
          {activeTag ? (
            <Link href={chipHref(locale, query, { tag: undefined })} className="chip chip-active">
              {t(locale, 'games.filterTag')} {activeTag} <span aria-hidden>✕</span>
            </Link>
          ) : null}
          {query.q ? (
            <Link href={chipHref(locale, query, { q: undefined })} className="chip chip-active">
              {t(locale, 'games.filterSearch')} {query.q} <span aria-hidden>✕</span>
            </Link>
          ) : null}
          <Link href={l(locale, '/games')} className="chip">{t(locale, 'games.clearFilters')}</Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr] lg:items-start">
        <aside className="grid gap-5 lg:sticky lg:top-24">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-black text-ink">{t(locale, 'nav.categories')}</h2>
            <ul className="grid gap-1">
              <li>
                <Link href={chipHref(locale, query, { category: undefined })} className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 ${!activeCategory ? 'font-bold text-brand' : 'text-ink'}`}>
                  <span>{t(locale, 'games.all')}</span>
                </Link>
              </li>
              {categories.slice(0, 20).map((category) => (
                <li key={category.id}>
                  <Link
                    href={chipHref(locale, query, { category: category.slug })}
                    aria-current={activeCategory === category.slug ? 'true' : undefined}
                    className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 ${activeCategory === category.slug ? 'font-bold text-brand' : 'text-ink'}`}
                  >
                    <span className="min-w-0 truncate">
                      <span aria-hidden className="ms-1">{category.icon ?? '•'}</span>
                      {pick(locale, category.name, category.nameEn)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{n(locale, category.gamesCount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {tags.length ? (
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-black text-ink">{t(locale, 'games.popularTags')}</h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.slice(0, 18).map((tag) => (
                  <Link key={tag.slug} href={chipHref(locale, query, { tag: tag.slug })} className={`chip text-[11px] ${activeTag === tag.slug ? 'chip-active' : ''}`}>
                    {pick(locale, tag.name, tag.nameEn)}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </aside>

        <div>
          {result.items.length ? (
            <>
              <GameGrid games={result.items} locale={locale} />
              <Pagination page={page} totalPages={totalPages} hrefFor={hrefFor} locale={locale} />
            </>
          ) : (
            <div className="card grid place-items-center px-6 py-16 text-center">
              <p className="mb-3 text-4xl" aria-hidden>🔍</p>
              <h2 className="mb-2 text-lg font-black text-ink">{t(locale, 'games.noMatchTitle')}</h2>
              <p className="mb-5 max-w-md text-sm leading-8 text-muted">{t(locale, 'games.noMatchBody')}</p>
              <Link href={l(locale, '/games')} className="btn btn-primary">{t(locale, 'games.showAll')}</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
