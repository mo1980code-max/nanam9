/**
 * /search — the server-rendered results page.
 *
 * The header's instant search covers the "I know roughly what I want" case; this page
 * covers the shared-link and SEO case. It is a normal document route, so `?q=car` has a
 * canonical URL, renders without JavaScript, and is what the site's SearchAction points at.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { GameGrid } from '@/components/game-card';
import { Pagination } from '@/components/pagination';
import { SearchBox } from '@/components/search-box';
import { getCategories, getSettings, listGames, settingValue } from '@/lib/api';

// Results depend entirely on the query string; each combination caches separately and
// there is no point warming them ahead of time.
export const revalidate = 30;

type Query = { q?: string; page?: string };

export async function generateMetadata({ searchParams }: { searchParams: Promise<Query> }): Promise<Metadata> {
  const { q } = await searchParams;
  const term = (q ?? '').trim();
  return {
    title: term ? `نتائج البحث: ${term}` : 'البحث في الألعاب',
    description: term ? `نتائج البحث عن «${term}».` : 'ابحث في كل ألعاب الموقع بالعنوان أو الوصف أو الوسوم.',
    // Search-result pages are thin by nature; keep them out of the index so they never
    // compete with the category pages for the same queries.
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Query> }) {
  const params = await searchParams;
  const term = (params.q ?? '').trim();
  const page = Math.max(1, Number(params.page) || 1);

  const [settings, categories] = await Promise.all([getSettings(), getCategories()]);
  const perPage = Number(settingValue(settings, 'games.perPage', 24)) || 24;
  const result = term ? await listGames({ q: term, page, perPage, sort: 'popular' }) : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <nav aria-label="مسار التنقل" className="mb-3 text-xs text-muted">
        <Link href="/" className="hover:text-brand">الرئيسية</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <span className="font-bold text-ink">البحث</span>
      </nav>

      <h1 className="mb-5 text-2xl font-black text-ink sm:text-3xl">{term ? `نتائج البحث عن «${term}»` : 'ابحث عن لعبتك'}</h1>

      <div className="mb-7">
        <SearchBox variant="page" initialValue={term} autoFocus={!term} />
      </div>

      {term && result && result.items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-3 text-4xl" aria-hidden>🤷</p>
          <h2 className="mb-2 text-lg font-black text-ink">لم نجد «{term}»</h2>
          <p className="mb-6 max-w-md text-sm leading-8 text-muted">
            جرّب تهجئة أخرى أو كلمة واحدة بدل جملة. هذه بعض التصنيفات التي قد تقودك إلى ما تبحث عنه.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {categories.slice(0, 8).map((category) => (
              <Link key={category.id} href={`/category/${category.slug}`} className="chip">
                <span aria-hidden>{category.icon ?? '•'}</span>
                {category.name}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {result && result.items.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-muted">{result.total.toLocaleString('ar-EG')} نتيجة</p>
          <GameGrid games={result.items} />
          <Pagination
            page={page}
            totalPages={result.totalPages}
            hrefFor={(target) => `/search?q=${encodeURIComponent(term)}&page=${target}`}
          />
        </>
      ) : null}

      {!term ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="card p-5">
            <h2 className="mb-2 text-sm font-black text-ink">تصنيفات سريعة</h2>
            <div className="flex flex-wrap gap-2">
              {categories.slice(0, 12).map((category) => (
                <Link key={category.id} href={`/category/${category.slug}`} className="chip">
                  <span aria-hidden>{category.icon ?? '•'}</span>
                  {category.name}
                </Link>
              ))}
            </div>
          </div>
          <div className="card p-5">
            <h2 className="mb-2 text-sm font-black text-ink">كيف تبحث؟</h2>
            <p className="text-sm leading-8 text-muted">
              ابحث باسم اللعبة أو بأي كلمة من وصفها. يمكنك أيضًا التصفية بالوسم من صفحة{' '}
              <Link href="/games" className="font-bold text-brand hover:underline">كل الألعاب</Link>.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
