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
import { getCategories, listGames, listPosts, siteUrl } from '@/lib/api';

export const revalidate = 600; // 10 minutes

const SITEMAP_GAME_LIMIT = 2000; // one sitemap file stays under the 50k-URL protocol limit with headroom

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const [categories, posts, games] = await Promise.all([
    getCategories(),
    listPosts({ perPage: 100, sort: 'newest' }),
    listGames({ perPage: SITEMAP_GAME_LIMIT, sort: 'updated' }),
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

  const gameEntries: MetadataRoute.Sitemap = games.items.map((game) => ({
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
