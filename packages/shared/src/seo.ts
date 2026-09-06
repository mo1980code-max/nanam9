/**
 * SEO primitives — plain data, no framework.
 *
 * The web app maps these onto Next.js `Metadata` and injects the JSON-LD in a
 * `<script type="application/ld+json">`. Keeping the builders here (not inside
 * components) means the API can emit the same structured data for a
 * `/api/games/:slug/ld+json` endpoint, an RSS feed or a server-rendered
 * fallback page without duplicating the logic — and it is unit-testable without
 * rendering React.
 */

export type JsonLd = Record<string, unknown> & { '@context': string };

const CONTEXT = 'https://schema.org';

export function buildTitle(opts: {
  title?: string | null;
  siteName: string;
  template?: string;
  suffixOnEmpty?: boolean;
}): string {
  const { title, siteName, template = '%s · %t' } = opts;
  const t = (title ?? '').trim();
  if (!t) return siteName;
  if (t === siteName) return siteName;
  return template.replace('%s', t).replace('%t', siteName);
}

export function buildDescription(text: string | null | undefined, max = 165): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${at > max * 0.6 ? cut.slice(0, at) : cut}…`;
}

/** Absolute URL join that never produces `//` or loses the path. */
export function absoluteUrl(baseUrl: string, path: string): string {
  const b = String(baseUrl ?? '').replace(/\/+$/, '');
  const p = String(path ?? '');
  if (/^https?:\/\//i.test(p)) return p;
  if (!p) return b || '/';
  return `${b}${p.startsWith('/') ? p : `/${p}`}`;
}

export type GameForJsonLd = {
  slug: string;
  title: string;
  titleEn?: string | null;
  description?: string | null;
  thumbnailUrl: string;
  bannerUrl?: string | null;
  url?: string | null;
  developer?: string | null;
  releaseYear?: number | null;
  ageRating?: string | null;
  ratingAvg?: number;
  ratingCount?: number;
  plays?: number;
  premium?: boolean;
  categories?: { slug: string; name: string }[];
  tags?: { slug: string; name: string }[];
  publishedAt?: string | null;
};

/**
 * schema.org/VideoGame. `aggregateRating` is only emitted when there is at
 * least one rating — an empty `ratingCount: 0` block is a rich-result warning in
 * Search Console, and Google treats a self-serving zero as spammy.
 */
export function gameJsonLd(game: GameForJsonLd, opts: { baseUrl: string; reviews?: unknown[] } = { baseUrl: '' }): JsonLd {
  const page = absoluteUrl(opts.baseUrl, `/game/${game.slug}`);
  const node: Record<string, unknown> = {
    '@context': CONTEXT,
    '@type': 'VideoGame',
    '@id': `${page}#game`,
    name: game.titleEn || game.title,
    alternateName: game.titleEn && game.title !== game.titleEn ? game.title : undefined,
    url: page,
    description: buildDescription(game.description ?? game.title, 300) || undefined,
    image: [game.thumbnailUrl, game.bannerUrl].filter(Boolean) as string[],
    inLanguage: game.titleEn ? ['ar', 'en'] : ['ar'],
    genre: game.categories?.map((c) => c.name).filter(Boolean),
    keywords: game.tags?.map((t) => t.name).join(', ') || undefined,
    datePublished: game.publishedAt ?? undefined,
    gamePlatform: ['HTML5', 'Web Browser', 'Mobile Web'],
    applicationCategory: 'Game',
    operatingSystem: 'Any',
    playMode: 'SinglePlayer',
  };
  if (game.developer) {
    node.creator = { '@type': 'Organization', name: game.developer };
    node.publisher = { '@type': 'Organization', name: game.developer };
  }
  if (game.releaseYear) node.dateCreated = String(game.releaseYear);
  if (game.ageRating) {
    node.contentRating = { everyone: 'Everyone', everyone_10: 'Everyone 10+', teen: 'Teen', mature: 'Mature 17+' }[
      game.ageRating
    ];
  }
  if (game.ratingCount && game.ratingCount > 0) {
    node.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number((game.ratingAvg ?? 0).toFixed(2)),
      reviewCount: game.ratingCount,
      ratingCount: game.ratingCount,
      bestRating: 5,
      worstRating: 1,
    };
  }
  if (typeof game.plays === 'number' && game.plays > 0) {
    node.interactionStatistic = {
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/PlayAction',
      userInteractionCount: game.plays,
    };
  }
  node.offers = {
    '@type': 'Offer',
    price: game.premium ? undefined : '0',
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    url: page,
    ...(game.premium ? { category: 'Premium subscription required' } : {}),
  };
  if (opts.reviews?.length) node.review = opts.reviews;
  return stripEmpty(node) as JsonLd;
}

export type Crumb = { name: string; path: string };

export function breadcrumbJsonLd(crumbs: Crumb[], baseUrl: string): JsonLd {
  return stripEmpty({
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: absoluteUrl(baseUrl, c.path),
    })),
  }) as JsonLd;
}

export function websiteJsonLd(opts: {
  baseUrl: string;
  name: string;
  logoUrl?: string | null;
  searchPath?: string;
  social?: Record<string, string | null | undefined>;
  sameAs?: string[];
}): JsonLd {
  const social = Object.values(opts.social ?? {})
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((handle) => (handle.startsWith('http') ? handle : handle));
  return stripEmpty({
    '@context': CONTEXT,
    '@type': 'WebSite',
    '@id': `${absoluteUrl(opts.baseUrl, '/')}#website`,
    url: absoluteUrl(opts.baseUrl, '/'),
    name: opts.name,
    publisher: {
      '@type': 'Organization',
      name: opts.name,
      url: absoluteUrl(opts.baseUrl, '/'),
      logo: opts.logoUrl
        ? { '@type': 'ImageObject', url: absoluteUrl(opts.baseUrl, opts.logoUrl) }
        : undefined,
      sameAs: [...social, ...(opts.sameAs ?? [])],
    },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${absoluteUrl(opts.baseUrl, opts.searchPath ?? '/search')}?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  }) as JsonLd;
}

export function itemListJsonLd(opts: {
  baseUrl: string;
  name: string;
  path: string;
  items: { slug: string; title: string }[];
}): JsonLd {
  return stripEmpty({
    '@context': CONTEXT,
    '@type': 'ItemList',
    name: opts.name,
    url: absoluteUrl(opts.baseUrl, opts.path),
    numberOfItems: opts.items.length,
    itemListElement: opts.items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: absoluteUrl(opts.baseUrl, `/game/${it.slug}`),
      name: it.title,
    })),
  }) as JsonLd;
}

export function blogPostingJsonLd(
  post: {
    slug: string;
    title: string;
    excerpt?: string | null;
    body?: string;
    coverImage?: string | null;
    publishedAt?: string | null;
    updatedAt?: string | null;
    readingMinutes?: number;
    author: { name: string; url?: string };
    categoryName?: string | null;
  },
  baseUrl: string,
): JsonLd {
  const url = absoluteUrl(baseUrl, `/blog/${post.slug}`);
  return stripEmpty({
    '@context': CONTEXT,
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    headline: post.title.slice(0, 110),
    description: buildDescription(post.excerpt ?? post.body, 300),
    image: post.coverImage ? [absoluteUrl(baseUrl, post.coverImage)] : undefined,
    datePublished: post.publishedAt ?? undefined,
    dateModified: post.updatedAt ?? post.publishedAt ?? undefined,
    wordCount: post.body ? post.body.split(/\s+/).length : undefined,
    timeRequired: post.readingMinutes ? `PT${post.readingMinutes}M` : undefined,
    articleSection: post.categoryName ?? undefined,
    author: { '@type': 'Person', name: post.author.name, url: post.author.url },
    publisher: { '@type': 'Organization', name: 'Voltade' },
    inLanguage: 'ar',
  }) as JsonLd;
}

export function faqJsonLd(items: { q: string; a: string }[]): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  };
}

/** Drops undefined/empty values so the emitted JSON-LD is small and valid. */
export function stripEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripEmpty(v)).filter((v) => !(v === undefined || v === null || v === '')) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripEmpty(v);
      if (cleaned === undefined || cleaned === null || cleaned === '') continue;
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      out[k] = cleaned;
    }
    return out as T;
  }
  return value;
}

/** `<script type="application/ld+json">` body — `</` escaped so a title can
 *  never close the script tag early (stored-XSS via JSON-LD is a real CVE class). */
export function jsonLdToString(node: JsonLd | JsonLd[]): string {
  return JSON.stringify(node).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
