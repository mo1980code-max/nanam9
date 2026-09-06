/**
 * /robots.txt
 *
 * Everything public is allowed; everything that is an interface rather than a page is
 * not. /search is excluded because indexable search-result pages dilute the crawl budget
 * and create near-duplicate URLs — the category pages are the canonical entry points.
 * /api is excluded because JSON endpoints are not pages (and crawling them would hammer
 * the database for nothing).
 */

import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/api';

export default function robots(): MetadataRoute.Robots {
  const host = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin/', '/search', '/u/', '/account'],
      },
      { userAgent: 'GPTBot', disallow: '/admin/' },
    ],
    sitemap: siteUrl('/sitemap.xml'),
    host,
  };
}
