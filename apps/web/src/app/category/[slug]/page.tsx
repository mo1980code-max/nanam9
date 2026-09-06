/**
 * /category/[slug] — a category landing page.
 *
 * Two things thin portals get wrong and this fixes:
 *  1. Category pages are usually bare duplicates of the game list. Here the category
 *     contributes its own description, colour, sub-categories and hero, so the page has
 *     a reason to exist for a search engine.
 *  2. Nested categories are flattened or ignored. Here children are first-class links
 *     and the BreadcrumbList JSON-LD walks the whole ancestry.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { GameGrid } from '@/components/game-card';
import { Pagination } from '@/components/pagination';
import { breadcrumbJsonLd, getCategory, getCategoryTrail, getSettings, listGames, settingValue, siteOrigin, siteUrl } from '@/lib/api';

export const revalidate = 60;

type Params = { slug: string };
type Query = { page?: string; sort?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategory(slug);
  if (!category) return { title: 'التصنيف غير موجود' };
  const title = `ألعاب ${category.name}`;
  const description = category.description || `تصفّح ${category.gamesCount.toLocaleString('ar-EG')} لعبة من تصنيف ${category.name}.`;
  const canonical = category.url || `/category/${category.slug}`;
  const image = category.thumbnailUrl ?? undefined;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: siteUrl(canonical), type: 'website', images: image ? [{ url: image }] : undefined },
    twitter: { card: image ? 'summary_large_image' : 'summary', title },
  };
}

export default async function CategoryPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Query> }) {
  const { slug } = await params;
  const query = await searchParams;
  const category = await getCategory(slug);
  if (!category) notFound();

  const page = Math.max(1, Number(query.page) || 1);
  const settings = await getSettings();
  const result = await listGames({
    page,
    perPage: Number(settingValue(settings, 'games.perPage', 24)) || 24,
    category: slug,
    sort: query.sort || 'newest',
  });
  const ancestry = await getCategoryTrail(slug);
  const trail = [
    { name: 'الرئيسية', url: '/' },
    { name: 'الألعاب', url: '/games' },
    ...ancestry.map((node) => ({ name: node.name, url: node.url || `/category/${node.slug}` })),
  ];
  const children = category.children ?? [];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd(trail, siteOrigin())) }} />

      <Breadcrumbs trail={trail} />

      <header
        className="mb-6 overflow-hidden rounded-3xl border border-line p-6 sm:p-8"
        style={{ background: `linear-gradient(135deg, ${category.color ?? '#7c3aed'}22, transparent 65%)` }}
      >
        <div className="flex items-start gap-4">
          <span aria-hidden className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface text-3xl shadow-sm">
            {category.icon ?? '🎮'}
          </span>
          <div className="min-w-0">
            <h1 className="mb-2 text-2xl font-black text-ink sm:text-4xl">{category.name}</h1>
            {category.description ? <p className="max-w-3xl text-sm leading-8 text-muted">{category.description}</p> : null}
            <p className="mt-3 text-xs font-bold text-brand">{category.gamesCount.toLocaleString('ar-EG')} لعبة في هذا التصنيف</p>
          </div>
        </div>

        {children.length ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {children.map((child) => (
              <Link key={child.id} href={child.url || `/category/${child.slug}`} className="chip">
                {child.icon ? <span aria-hidden>{child.icon}</span> : null}
                {child.name}
              </Link>
            ))}
          </div>
        ) : null}
      </header>

      {result.items.length ? (
        <>
          <GameGrid games={result.items} />
          <Pagination
            page={page}
            totalPages={result.totalPages}
            hrefFor={(target) => `/category/${slug}?page=${target}${query.sort ? `&sort=${encodeURIComponent(query.sort)}` : ''}`}
          />
        </>
      ) : (
        <div className="card grid place-items-center px-6 py-16 text-center">
          <p className="mb-3 text-4xl" aria-hidden>🗂️</p>
          <h2 className="mb-2 text-lg font-black text-ink">لا ألعاب في هذا التصنيف بعد</h2>
          <p className="mb-5 text-sm text-muted">سنضيف ألعابًا هنا قريبًا. تصفّح بقية التصنيفات في هذه الأثناء.</p>
          <Link href="/games" className="btn btn-primary">كل الألعاب</Link>
        </div>
      )}
    </div>
  );
}
