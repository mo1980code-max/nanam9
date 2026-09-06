/**
 * /sitemap.xml — generated, never hand-maintained.
 *
 * A portal with 20 000 games cannot keep a checked-in sitemap true. This route rebuilds
 * the index from the database on a cache window (10 minutes), which Google re-crawls on
 * its own schedule; that is the standard pattern: cheap enough to serve from cache,
 * fresh enough that a game published an hour ago is discoverable today.
 *
 * Priorities are not random: the home page and categories are the entry points that
 * distribute authority, game pages are the money pages, profiles are deliberately low.
 */

import type { MetadataRoute } from 'next';
import { getCategories, listGames, listPosts, siteUrl, type GameCard } from '@/lib/api';

export const revalidate = 60; // one minute: cheap from cache, fresh enough for publishing

const SITEMAP_GAME_LIMIT = 2000; // one sitemap file stays under the 50k-URL protocol limit with headroom
const PAGE_SIZE = 60; // the API's hard perPage cap (PAGINATION.maxPerPage in @voltade/shared)

/**
 * Walks the catalogue page by page. Asking for 2000 rows in one call would hit the
 * API's perPage validation and — worse — fail *silently* into an empty sitemap,
 * which is exactly the kind of bug that costs a portal its index coverage.
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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const [categories, posts, games] = await Promise.all([
    getCategories(),
    listPosts({ perPage: 50, sort: 'newest' }),
    allGames(SITEMAP_GAME_LIMIT),
  ]);

  const staticEntries: MetadataRoute.Sitemap = [
    { url: siteUrl('/'), changeFrequency: 'hourly', priority: 1 },
    { url: siteUrl('/games'), changeFrequency: 'hourly', priority: 0.9 },
    { url: siteUrl('/blog'), changeFrequency: 'daily', priority: 0.7 },
    { url: siteUrl('/leaderboard'), changeFrequency: 'hourly', priority: 0.4 },
  ];

  const categoryEntries: MetadataRoute.Sitemap = categories
    .filter((category) => category.isVisible !== false)
    .map((category) => ({
      url: siteUrl(category.url || `/category/${category.slug}`),
      changeFrequency: 'daily',
      priority: 0.8,
    }));

  const gameEntries: MetadataRoute.Sitemap = games.map((game) => ({
    url: siteUrl(`/game/${game.slug}`),
    lastModified: game.publishedAt ? new Date(game.publishedAt) : now,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));

  const postEntries: MetadataRoute.Sitemap = posts.items.map((post) => ({
    url: siteUrl(`/blog/${post.slug}`),
    lastModified: post.updatedAt ? new Date(post.updatedAt) : post.publishedAt ? new Date(post.publishedAt) : now,
    changeFrequency: 'monthly',
    priority: 0.5,
  }));

  return [...staticEntries, ...categoryEntries, ...gameEntries, ...postEntries];
}
