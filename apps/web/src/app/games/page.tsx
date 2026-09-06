/**
 * /games — the full catalogue.
 *
 * Every filter is a query parameter, so every filtered view is a shareable, indexable
 * URL and works with the back button. That is deliberately different from doing the
 * filtering in a client component: a portal that filters in JavaScript sends first HTML
 * containing none of it, and a crawler sees nothing.
 *
 * The page is ISR with a short window; each distinct query string gets its own cache
 * entry, which is exactly how a 20 000-game catalogue stays cheap to serve.
 */

import Link from 'next/link';
import { GameGrid } from '@/components/game-card';
import { Pagination } from '@/components/pagination';
import { SearchBox } from '@/components/search-box';
import { GAME_SORTS, getCategories, getSettings, getTags, listGames, settingValue } from '@/lib/api';

export const revalidate = 30;

type Query = { page?: string; sort?: string; category?: string; tag?: string; q?: string };

const SORT_LABELS: Record<string, string> = {
  newest: 'الأحدث',
  popular: 'الأكثر لعبًا',
  top_rated: 'الأعلى تقييمًا',
  most_liked: 'الأكثر إعجابًا',
  trending: 'الرائج',
  random: 'عشوائي',
  az: 'أبجدي',
  updated: 'المحدّثة',
};

/** Every chip rewrites the query and drops the page number: changing a filter returns you to page 1. */
function chipHref(base: Query, patch: Partial<Query>) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...patch })) {
    if (value && key !== 'page') next[key] = value;
  }
  const search = new URLSearchParams(next).toString();
  return search ? `/games?${search}` : '/games';
}

export default async function GamesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const sort = (GAME_SORTS as readonly string[]).includes(params.sort ?? '') ? params.sort : 'newest';

  const settings = await getSettings();
  const perPage = Number(settingValue(settings, 'games.perPage', 24)) || 24;
  const [categories, tags, result] = await Promise.all([
    getCategories(),
    getTags(28),
    listGames({
      page,
      perPage,
      sort,
      category: params.category || undefined,
      tag: params.tag || undefined,
      q: params.q || undefined,
    }),
  ]);

  const totalPages = result.totalPages;
  const activeCategory = params.category;
  const activeTag = params.tag;
  const heading = activeCategory
    ? (categories.find((category) => category.slug === activeCategory)?.name ?? `تصنيف ${activeCategory}`)
    : activeTag
      ? `وسم: ${tags.find((tag) => tag.slug === activeTag)?.name ?? activeTag}`
      : params.q
        ? `نتائج البحث عن «${params.q}»`
        : 'كل الألعاب';

  const hrefFor = (target: number) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) if (value && key !== 'page') next[key] = value;
    next.page = String(target);
    return `/games?${new URLSearchParams(next).toString()}`;
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_300px] lg:items-start">
        <div>
          <nav aria-label="مسار التنقل" className="mb-2 text-xs text-muted">
            <Link href="/" className="hover:text-brand">الرئيسية</Link>
            <span aria-hidden className="mx-1.5">/</span>
            <span className="font-bold text-ink">الألعاب</span>
          </nav>
          <h1 className="mb-1 text-2xl font-black text-ink sm:text-3xl">{heading}</h1>
          <p className="text-sm text-muted">
            {result.total.toLocaleString('ar-EG')} لعبة — اختر ترتيبًا أو صفِّ بالمزاج الذي يناسبك.
          </p>
        </div>
        <SearchBox variant="page" initialValue={params.q ?? ''} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="ترتيب النتائج">
        <span className="text-xs font-bold text-muted">الترتيب:</span>
        {GAME_SORTS.map((value) => (
          <Link
            key={value}
            href={chipHref(params, { sort: value })}
            aria-current={sort === value ? 'true' : undefined}
            className={`chip ${sort === value ? 'chip-active' : ''}`}
          >
            {SORT_LABELS[value] ?? value}
          </Link>
        ))}
      </div>

      {(activeCategory || activeTag || params.q) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {activeCategory ? (
            <Link href={chipHref(params, { category: undefined })} className="chip chip-active">
              تصنيف: {activeCategory} <span aria-hidden>✕</span>
            </Link>
          ) : null}
          {activeTag ? (
            <Link href={chipHref(params, { tag: undefined })} className="chip chip-active">
              وسم: {activeTag} <span aria-hidden>✕</span>
            </Link>
          ) : null}
          {params.q ? (
            <Link href={chipHref(params, { q: undefined })} className="chip chip-active">
              بحث: {params.q} <span aria-hidden>✕</span>
            </Link>
          ) : null}
          <Link href="/games" className="chip">مسح كل المرشحات</Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr] lg:items-start">
        <aside className="grid gap-5 lg:sticky lg:top-24">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-black text-ink">التصنيفات</h2>
            <ul className="grid gap-1">
              <li>
                <Link href={chipHref(params, { category: undefined })} className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 ${!activeCategory ? 'font-bold text-brand' : 'text-ink'}`}>
                  <span>الكل</span>
                </Link>
              </li>
              {categories.slice(0, 20).map((category) => (
                <li key={category.id}>
                  <Link
                    href={chipHref(params, { category: category.slug })}
                    aria-current={activeCategory === category.slug ? 'true' : undefined}
                    className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 ${activeCategory === category.slug ? 'font-bold text-brand' : 'text-ink'}`}
                  >
                    <span className="min-w-0 truncate">
                      <span aria-hidden className="ms-1">{category.icon ?? '•'}</span>
                      {category.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{category.gamesCount.toLocaleString('ar-EG')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {tags.length ? (
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-black text-ink">وسوم شائعة</h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.slice(0, 18).map((tag) => (
                  <Link key={tag.slug} href={chipHref(params, { tag: tag.slug })} className={`chip text-[11px] ${activeTag === tag.slug ? 'chip-active' : ''}`}>
                    {tag.name}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </aside>

        <div>
          {result.items.length ? (
            <>
              <GameGrid games={result.items} />
              <Pagination page={page} totalPages={totalPages} hrefFor={hrefFor} />
            </>
          ) : (
            <div className="card grid place-items-center px-6 py-16 text-center">
              <p className="mb-3 text-4xl" aria-hidden>🔍</p>
              <h2 className="mb-2 text-lg font-black text-ink">لا نتائج مطابقة</h2>
              <p className="mb-5 max-w-md text-sm leading-8 text-muted">
                جرّب كلمة أقصر أو أقل تحديدًا، أو أزل بعض المرشحات. يمكنك أيضًا تصفّح كل الألعاب من البداية.
              </p>
              <Link href="/games" className="btn btn-primary">عرض كل الألعاب</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
