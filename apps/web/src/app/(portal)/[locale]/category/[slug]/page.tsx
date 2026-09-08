/**
 * /[locale]/category/[slug] — a category landing page, in both languages.
 *
 * The category contributes its own description, colour, sub-categories and hero; the
 * BreadcrumbList JSON-LD walks the whole ancestry. English visitors get `nameEn`
 * (falling back to Arabic) and the localized chrome.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { GameGrid } from '@/components/game-card';
import { Pagination } from '@/components/pagination';
import { breadcrumbJsonLd, getCategory, getCategoryTrail, getSettings, listGames, settingValue, siteOrigin, siteUrl } from '@/lib/api';
import { isLocale, l, localeAlternates, n, pick, t, type Locale } from '@/lib/i18n';

export const revalidate = 60;

type Params = { locale: string; slug: string };
type Query = { page?: string; sort?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  const category = await getCategory(slug);
  if (!category) return { title: t(locale, 'category.notFound') };
  const name = pick(locale, category.name, category.nameEn);
  const title = t(locale, 'category.titlePrefix', { name });
  const description = category.description || t(locale, 'category.defaultDescription', { count: n(locale, category.gamesCount), name });
  const image = category.thumbnailUrl ?? undefined;
  return {
    title,
    description,
    alternates: localeAlternates(locale, `/category/${category.slug}`),
    openGraph: { title, description, url: siteUrl(l(locale, `/category/${category.slug}`)), type: 'website', images: image ? [{ url: image }] : undefined },
    twitter: { card: image ? 'summary_large_image' : 'summary', title },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

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
    { name: t(locale, 'crumbs.home'), url: '/' },
    { name: t(locale, 'nav.games'), url: '/games' },
    ...ancestry.map((node) => ({ name: node.name, url: node.url || `/category/${node.slug}` })),
  ];
  const children = category.children ?? [];
  const name = pick(locale, category.name, category.nameEn);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd(trail, siteOrigin())) }} />

      <Breadcrumbs trail={trail} locale={locale} />

      <header
        className="mb-6 overflow-hidden rounded-3xl border border-line p-6 sm:p-8"
        style={{ background: `linear-gradient(135deg, ${category.color ?? '#7c3aed'}22, transparent 65%)` }}
      >
        <div className="flex items-start gap-4">
          <span aria-hidden className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface text-3xl shadow-sm">
            {category.icon ?? '🎮'}
          </span>
          <div className="min-w-0">
            <h1 className="mb-2 text-2xl font-black text-ink sm:text-4xl">{name}</h1>
            {category.description ? <p className="max-w-3xl text-sm leading-8 text-muted">{category.description}</p> : null}
            <p className="mt-3 text-xs font-bold text-brand">{t(locale, 'category.gamesIn', { count: n(locale, category.gamesCount) })}</p>
          </div>
        </div>

        {children.length ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {children.map((child) => (
              <Link key={child.id} href={child.url ? l(locale, child.url) : l(locale, `/category/${child.slug}`)} className="chip">
                {child.icon ? <span aria-hidden>{child.icon}</span> : null}
                {pick(locale, child.name, child.nameEn)}
              </Link>
            ))}
          </div>
        ) : null}
      </header>

      {result.items.length ? (
        <>
          <GameGrid games={result.items} locale={locale} />
          <Pagination
            page={page}
            totalPages={result.totalPages}
            hrefFor={(target) => l(locale, `/category/${slug}?page=${target}${query.sort ? `&sort=${encodeURIComponent(query.sort)}` : ''}`)}
            locale={locale}
          />
        </>
      ) : (
        <div className="card grid place-items-center px-6 py-16 text-center">
          <p className="mb-3 text-4xl" aria-hidden>🗂️</p>
          <h2 className="mb-2 text-lg font-black text-ink">{t(locale, 'category.emptyTitle')}</h2>
          <p className="mb-5 text-sm text-muted">{t(locale, 'category.emptyBody')}</p>
          <Link href={l(locale, '/games')} className="btn btn-primary">{t(locale, 'nav.allGames')}</Link>
        </div>
      )}
    </div>
  );
}
