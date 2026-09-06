/**
 * The server-side API client.
 *
 * TWO RULES, BOTH ABOUT THE ORIGIN:
 *
 * 1. Server Components fetch the API directly on 127.0.0.1 — one hop, no proxy, no
 *    browser involved. Client components instead call relative `/api/...` paths that
 *    next.config rewrites to the API, because a browser cannot reach this sandbox's
 *    loopback address.
 *
 * 2. Every media URL that leaves the API is absolute against *the API's* origin
 *    (`http://localhost:4000/games/x/thumb.svg`). Left alone, the browser would try to
 *    load that host and fail. `mediaUrl()` strips the origin so the path resolves
 *    against the web app, where the seeded games live in `public/` and uploads are
 *    proxied from storage.
 *
 * Failures return `null` rather than throwing: a portal whose homepage 500s because the
 * API hiccuped once is worse than one that renders the shell and an empty rail. The
 * status is still logged, so the degradation is visible in the server output.
 */

import { cache } from 'react';

// The canonical sort vocabulary lives in the shared package so the API's validation,
// the admin UI and this app cannot drift apart. Re-exported here so pages have one
// import source for everything data-shaped.
export { GAME_SORTS } from '@voltade/shared';

const API_ORIGIN = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

export type Term = { slug: string; name: string };

export type GameCard = {
  id: string;
  slug: string;
  title: string;
  titleEn: string | null;
  thumbnailUrl: string | null;
  kind: string;
  orientation: string | null;
  ageRating: string | null;
  featured: boolean;
  premium: boolean;
  plays: number;
  likesCount: number;
  dislikesCount: number;
  ratingAvg: number | null;
  ratingCount: number;
  commentsCount: number;
  width: number | null;
  height: number | null;
  publishedAt: string | null;
  categories: Term[];
  tags: Term[];
};

export type GameDetail = GameCard & {
  url: string;
  filePath: string | null;
  bannerUrl: string | null;
  description: string | null;
  instructions: string | null;
  developer: string | null;
  releaseYear: number | null;
  version: string | null;
  sizeKb: number | null;
  source: string | null;
  favoritesCount: number;
  uniquePlays: number;
  gallery: unknown[];
  seo: { title: string | null; description: string | null; keywords?: string | null; canonical?: string | null };
};

export type GamePage = {
  game: GameDetail;
  related: GameCard[];
  trail: { name: string; url: string }[];
  viewer: {
    authenticated: boolean;
    favorite: boolean;
    rating: number | null;
    review: string | null;
    vote: 'like' | 'dislike' | null;
    plays: number;
    lastPlayedAt: string | null;
    playlists: { id: string; title: string }[];
  };
};

export type Category = {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  icon: string | null;
  thumbnailUrl: string | null;
  color: string | null;
  gamesCount: number;
  isVisible: boolean;
  sortOrder: number;
  url: string;
  parent: { slug: string; name: string } | null;
  children: Category[];
};

export type Section = {
  id: string;
  page: string;
  kind: string;
  title: string | null;
  titleEn: string | null;
  subtitle: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
  isVisible: boolean;
};

export type BlogCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  url: string;
  parentId: string | null;
  postsCount: number;
  sortOrder: number;
  children: BlogCategory[];
};

export type PostCard = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  coverImage: string | null;
  url: string;
  author: { username: string; displayName: string | null; avatarUrl: string | null } | null;
  category: Term | null;
  status: string;
  live: boolean;
  publishedAt: string | null;
  updatedAt: string;
  readingMinutes: number;
  views: number;
};

export type PostView = PostCard & {
  body: string;
  tags: Term[];
  seo: { title: string | null; description: string | null; canonical: string | null; robots: string };
  jsonLd: Record<string, unknown>[];
  related: PostCard[];
  preview: boolean;
};

export type PageBlock = { id: string; type: string; props: Record<string, unknown> };

export type PageView = {
  id: string;
  slug: string;
  title: string;
  titleEn: string | null;
  url: string;
  template: string;
  status: string;
  live: boolean;
  body: string | null;
  blocks: PageBlock[];
  isIndexed: boolean;
  sortOrder: number;
  updatedAt: string;
  seo: { title: string | null; description: string | null; canonical: string | null; robots: string };
  jsonLd: Record<string, unknown>[];
  preview: boolean;
};

export type Comment = {
  id: string;
  body: string;
  createdAt: string;
  author: { username: string; displayName: string | null; avatarUrl: string | null } | null;
  parentId: string | null;
  children?: Comment[];
  likesCount?: number;
};

export type ListResult<T> = { items: T[]; total: number; page: number; perPage: number; totalPages: number };

export type Settings = Record<string, unknown>;

/** Strips the API origin from a stored media URL so the browser resolves it here. */
export function mediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('//')) return value;
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return value;
  }
}

type FetchOptions = { revalidate?: number; tags?: string[] };

/**
 * One GET, one envelope unwrap, one place that knows what a failure means.
 * Wrapped in React's per-request cache so a page that needs the same rail twice
 * (the header nav and a section, say) pays for it once.
 */
async function getJson<T>(path: string, options: FetchOptions = {}): Promise<T | null> {
  const url = `${API_ORIGIN}/api${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      next: { revalidate: options.revalidate ?? 60, tags: options.tags },
    });
    if (!response.ok) {
      if (response.status >= 500) console.error(`[api] ${path} → ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as { ok: boolean; data: T };
    return payload.ok ? payload.data : null;
  } catch (error) {
    console.error(`[api] ${path} unreachable:`, (error as Error).message);
    return null;
  }
}

function unwrapList<T>(data: unknown, fallbackPage: { page: number; perPage: number }): ListResult<T> {
  const items = Array.isArray(data) ? (data as T[]) : ((data as { items?: T[] })?.items ?? []);
  const meta = (data as { total?: number; page?: number; perPage?: number; totalPages?: number }) ?? {};
  return {
    items,
    total: meta.total ?? items.length,
    page: meta.page ?? fallbackPage.page,
    perPage: meta.perPage ?? fallbackPage.perPage,
    totalPages: meta.totalPages ?? Math.max(1, Math.ceil((meta.total ?? items.length) / (meta.perPage ?? fallbackPage.perPage))),
  };
}

const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
};

// ── settings & chrome ──────────────────────────────────────────────────────

export const getSettings = cache(async (): Promise<Settings> => (await getJson<Settings>('/settings', { revalidate: 300 })) ?? {});

export function settingValue<T = string>(settings: Settings, key: string, fallback: T): T {
  const value = settings[key];
  return value === undefined || value === null || value === '' ? fallback : (value as T);
}

export const getSections = cache(async (page = 'home'): Promise<Section[]> => {
  const data = await getJson<Section[] | { items: Section[] }>(`/sections${qs({ page })}`, { revalidate: 60 });
  if (!data) return [];
  return Array.isArray(data) ? data : data.items ?? [];
});

export const getCategories = cache(async (): Promise<Category[]> => {
  const data = await getJson<Category[] | { items: Category[] }>('/categories', { revalidate: 300 });
  if (!data) return [];
  return Array.isArray(data) ? data : data.items ?? [];
});

export const getCategory = cache(async (slug: string): Promise<Category | null> => {
  const all = await getCategories();
  const search = (list: Category[]): Category | null => {
    for (const item of list) {
      if (item.slug === slug) return item;
      const nested = search(item.children ?? []);
      if (nested) return nested;
    }
    return null;
  };
  return search(all);
});

/**
 * The ancestry path of a category, root-first: [root, …, category].
 *
 * The public category object only carries its immediate parent, so a three-level tree
 * cannot be walked upwards from a node. Walking *down* the cached tree once is O(nodes)
 * and gives the exact path breadcrumbs and BreadcrumbList JSON-LD need.
 */
export const getCategoryTrail = cache(async (slug: string): Promise<Category[]> => {
  const all = await getCategories();
  const path: Category[] = [];
  const walk = (list: Category[], trail: Category[]): boolean => {
    for (const item of list) {
      const next = [...trail, item];
      if (item.slug === slug) {
        path.push(...next);
        return true;
      }
      if (walk(item.children ?? [], next)) return true;
    }
    return false;
  };
  walk(all, []);
  return path;
});

// ── games ──────────────────────────────────────────────────────────────────

export type GameQuery = {
  page?: number;
  perPage?: number;
  category?: string;
  tag?: string;
  q?: string;
  sort?: string;
  featured?: boolean;
  orientation?: string;
  ageRating?: string;
};

export const listGames = cache(async (query: GameQuery = {}): Promise<ListResult<GameCard>> => {
  const page = query.page ?? 1;
  const perPage = query.perPage ?? 24;
  const data = await getJson<unknown>(
    `/games${qs({
      page,
      perPage,
      category: query.category,
      tag: query.tag,
      q: query.q,
      sort: query.sort,
      featured: query.featured === undefined ? undefined : query.featured ? 'true' : undefined,
      orientation: query.orientation,
      ageRating: query.ageRating,
    })}`,
    { revalidate: 30, tags: ['games'] },
  );
  return unwrapList<GameCard>(data, { page, perPage });
});

export const getGame = cache(async (slug: string): Promise<GamePage | null> =>
  getJson<GamePage>(`/games/${encodeURIComponent(slug)}`, { revalidate: 60, tags: ['games', `game:${slug}`] }),
);

export const searchGames = cache(async (term: string, limit = 8): Promise<GameCard[]> => {
  const data = await getJson<unknown>(`/games/search${qs({ q: term, perPage: limit })}`, { revalidate: 0 });
  return unwrapList<GameCard>(data, { page: 1, perPage: limit }).items;
});

export const randomGames = cache(async (limit = 6, category?: string): Promise<GameCard[]> => {
  const data = await getJson<unknown>(`/games/random${qs({ limit, category })}`, { revalidate: 0 });
  return unwrapList<GameCard>(data, { page: 1, perPage: limit }).items;
});

export const getTags = cache(async (limit = 40): Promise<(Term & { count?: number })[]> => {
  const data = await getJson<unknown>(`/tags${qs({ limit })}`, { revalidate: 600 });
  return unwrapList<Term & { count?: number }>(data, { page: 1, perPage: limit }).items;
});

export type LeaderRow = {
  rank: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  level: number;
  xp: number;
  plays: number;
  url: string;
};

export const getLeaderboard = cache(async (limit = 8): Promise<LeaderRow[]> => {
  const data = await getJson<unknown>(`/leaderboard${qs({ limit })}`, { revalidate: 120 });
  return unwrapList<LeaderRow>(data, { page: 1, perPage: limit }).items;
});

export const getUserProfile = cache(async (username: string): Promise<Record<string, unknown> | null> =>
  getJson<Record<string, unknown>>(`/users/${encodeURIComponent(username)}`, { revalidate: 60 }),
);

// ── content ────────────────────────────────────────────────────────────────

export const listPosts = cache(
  async (query: { page?: number; perPage?: number; category?: string; tag?: string; q?: string; sort?: string } = {}): Promise<
    ListResult<PostCard>
  > => {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 12;
    const data = await getJson<unknown>(`/blog/posts${qs({ page, perPage, category: query.category, tag: query.tag, q: query.q, sort: query.sort })}`, {
      revalidate: 60,
      tags: ['posts'],
    });
    return unwrapList<PostCard>(data, { page, perPage });
  },
);

export const getPost = cache(async (slug: string): Promise<PostView | null> =>
  getJson<PostView>(`/blog/posts/${encodeURIComponent(slug)}`, { revalidate: 300, tags: ['posts', `post:${slug}`] }),
);

export const getBlogCategories = cache(async (): Promise<BlogCategory[]> => {
  const data = await getJson<{ items?: BlogCategory[] }>('/blog/categories', { revalidate: 300 });
  return data?.items ?? [];
});

export const getPage = cache(async (slug: string): Promise<PageView | null> =>
  getJson<PageView>(`/pages/${encodeURIComponent(slug)}`, { revalidate: 300, tags: ['pages'] }),
);

export const getLivePages = cache(async (): Promise<{ slug: string; title: string; url: string }[]> => {
  const data = await getJson<{ items?: { slug: string; title: string; url: string }[] }>('/pages', { revalidate: 300 });
  return data?.items ?? [];
});

export const getComments = cache(async (gameId: string, limit = 20): Promise<Comment[]> => {
  const data = await getJson<unknown>(`/comments${qs({ gameId, limit })}`, { revalidate: 0 });
  return unwrapList<Comment>(data, { page: 1, perPage: limit }).items;
});

// ── SEO helpers ────────────────────────────────────────────────────────────

/** The bare public origin (no trailing slash): the `baseUrl` argument of the JSON-LD builders. */
export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** The public origin of *this* app: what sitemaps, canonicals and OG tags must use. */
export function siteUrl(path = '/'): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function gameJsonLd(game: GameDetail, baseUrl: string): Record<string, unknown> {
  const url = `${baseUrl}/game/${game.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    '@id': `${url}#game`,
    url,
    name: game.title,
    alternateName: game.titleEn ?? undefined,
    description: game.description ?? undefined,
    image: [mediaUrl(game.thumbnailUrl), mediaUrl(game.bannerUrl)].filter(Boolean),
    gamePlatform: 'Web Browser',
    applicationCategory: 'Game',
    operatingSystem: 'Any',
    numberOfPlayers: '1',
    author: game.developer ? { '@type': 'Organization', name: game.developer } : undefined,
    datePublished: game.publishedAt ?? undefined,
    aggregateRating:
      game.ratingCount > 0
        ? {
            '@type': 'AggregateRating',
            ratingValue: game.ratingAvg ?? 0,
            reviewCount: game.ratingCount,
            bestRating: 5,
            worstRating: 1,
          }
        : undefined,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  };
}

export function breadcrumbJsonLd(crumbs: { name: string; url: string }[], baseUrl: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.url.startsWith('http') ? crumb.url : `${baseUrl}${crumb.url}`,
    })),
  };
}
