/**
 * /sitemap.xml — generated, never hand-maintained, and now BILINGUAL.
 *
 * Every URL appears twice (ar + en) with `alternates.languages` — Next renders those as
 * xhtml:link hreflang tags inside the sitemap, which is exactly what Google asks for to
 * cluster the two language versions instead of treating one as duplicate content.
 *
 * Priorities are not random: the home page and categories are the entry points that
 * distribute authority, game pages are the money pages, profiles are deliberately low.
 */

import type { MetadataRoute } from 'next';
import { getCategories, listGames, listPosts, siteUrl, type GameCard } from '@/lib/api';
import { LOCALES } from '@/lib/i18n';

export const revalidate = 60; // one minute: cheap from cache, fresh enough for publishing

const SITEMAP_GAME_LIMIT = 2000; // one sitemap file stays under the 50k-URL protocol limit with headroom
const PAGE_SIZE = 60; // the API's hard perPage cap (PAGINATION.maxPerPage in @voltade/shared)

/**
 * Walks the catalogue page by page. Asking for 2000 rows in one call would hit the
 * API's perPage validation and — worse — fail *silently* into an empty sitemap.
 */
async function allGames(limit: number): Promise<GameCard[]> {
  const out: GameCard[] = [];
  for (let page = 1; out.length < limit && page <= 40; page += 1) {
    const result = await listGames({ page, perPage: PAGE_SIZE, sort: 'updated' });
    if (!result.items.length) break;
    out.push(...result.items);
    if (out.length >= result.total) break;
  }
  return out.slice(0, limit);
}

/** One entry per locale with the hreflang cluster attached. */
function bilingual(
  path: string,
  options: { changeFrequency?: MetadataRoute.Sitemap[number]['changeFrequency']; priority?: number; lastModified?: Date } = {},
): MetadataRoute.Sitemap {
  return LOCALES.map((locale) => ({
    url: siteUrl(`/${locale}${path === '/' ? '' : path}`),
    lastModified: options.lastModified,
    changeFrequency: options.changeFrequency,
    priority: options.priority,
    alternates: {
      languages: Object.fromEntries(LOCALES.map((each) => [each, siteUrl(`/${each}${path === '/' ? '' : path}`)])),
    },
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const [categories, posts, games] = await Promise.all([
    getCategories(),
    listPosts({ perPage: 50, sort: 'newest' }),
    allGames(SITEMAP_GAME_LIMIT),
  ]);

  const staticEntries = [
    ...bilingual('/', { changeFrequency: 'hourly', priority: 1 }),
    ...bilingual('/games', { changeFrequency: 'hourly', priority: 0.9 }),
    ...bilingual('/blog', { changeFrequency: 'daily', priority: 0.7 }),
    ...bilingual('/leaderboard', { changeFrequency: 'hourly', priority: 0.4 }),
  ];

  const categoryEntries = categories
    .filter((category) => category.isVisible !== false)
    .flatMap((category) => bilingual(`/category/${category.slug}`, { changeFrequency: 'daily', priority: 0.8 }));

  const gameEntries = games.flatMap((game) =>
    bilingual(`/game/${game.slug}`, {
      lastModified: game.publishedAt ? new Date(game.publishedAt) : now,
      changeFrequency: 'weekly',
      priority: 0.7,
    }),
  );

  const postEntries = posts.items.flatMap((post) =>
    bilingual(`/blog/${post.slug}`, {
      lastModified: post.updatedAt ? new Date(post.updatedAt) : post.publishedAt ? new Date(post.publishedAt) : now,
      changeFrequency: 'monthly',
      priority: 0.5,
    }),
  );

  return [...staticEntries, ...categoryEntries, ...gameEntries, ...postEntries];
}
