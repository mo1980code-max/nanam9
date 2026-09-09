/**
 * Wire types shared by the API (which produces them) and the web app (which
 * consumes them in React Server Components). Keeping them here means a rename
 * in the API breaks the web build — which is exactly when we want to hear about
 * it, not at 3am in production.
 */

/** Every successful API response is wrapped, so the client can branch on `ok`
 *  without inspecting status codes, and `meta` has one canonical home. */
export type ApiOk<T, M extends object = Record<string, never>> = {
  ok: true;
  data: T;
  meta?: M;
};

export type ApiErr = {
  ok: false;
  error: {
    code: string;
    message: string;
    /** class-validator field errors, keyed by property. */
    fields?: Record<string, string[]>;
    /** present on 429 so the client can back off precisely. */
    retryAfterSeconds?: number;
  };
};

export type ApiResponse<T, M extends object = Record<string, never>> = ApiOk<T, M> | ApiErr;

export type Paged<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type PagedMeta = { pagination: Omit<Paged<never>, 'items'> };

/**
 * Sort orders the catalogue supports. The API maps each one to an index that
 * actually exists (see packages/db/prisma/schema.prisma), so this list is also
 * the list of "cheap" orderings — adding a value here means adding an index.
 *
 * The union type is derived FROM the array, so `?sort=` validation in the API and
 * the switch in the UI can never drift apart.
 */
export const GAME_SORTS = ['newest', 'popular', 'top_rated', 'most_liked', 'trending', 'random', 'az', 'updated'] as const;
export type GameSort = (typeof GAME_SORTS)[number];

export type GameCard = {
  id: string;
  slug: string;
  title: string;
  titleEn?: string | null;
  thumbnailUrl: string;
  kind: string;
  width?: number | null;
  height?: number | null;
  featured: boolean;
  premium: boolean;
  ageRating: string;
  plays: number;
  ratingAvg: number;
  ratingCount: number;
  likesCount: number;
  publishedAt?: string | null;
  categories?: { slug: string; name: string }[];
};

export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  nameEn?: string | null;
  icon?: string | null;
  thumbnailUrl?: string | null;
  color?: string | null;
  gamesCount: number;
  sortOrder: number;
  parentId?: string | null;
  children?: CategoryNode[];
};

export type GameDetail = GameCard & {
  description?: string | null;
  descriptionEn?: string | null;
  instructions?: string | null;
  developer?: string | null;
  url: string;
  filePath?: string | null;
  orientation: string;
  sizeKb?: number | null;
  bannerUrl?: string | null;
  gallery: string[];
  status: string;
  dislikesCount: number;
  commentsCount: number;
  favoritesCount: number;
  uniquePlays: number;
  releaseYear?: number | null;
  version?: string | null;
  providerSlug?: string | null;
  tags: { slug: string; name: string }[];
  seo: {
    title?: string | null;
    description?: string | null;
    keywords?: string | null;
    canonicalUrl?: string | null;
    noindex: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type CommentNode = {
  id: string;
  body: string;
  status: string;
  likesCount: number;
  dislikesCount: number;
  createdAt: string;
  parentId?: string | null;
  author: {
    id?: string | null;
    name: string;
    avatarUrl?: string | null;
  };
  children?: CommentNode[];
};

export type SiteSettings = {
  siteName: string;
  siteNameEn: string;
  tagline: string;
  taglineEn: string;
  baseUrl: string;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  ogImageUrl?: string | null;
  locale: 'ar' | 'en';
  rtl: boolean;
  theme: string;
  gamesPerPage: number;
  commentsPerPage: number;
  adsEnabled: boolean;
  registrationEnabled: boolean;
  guestComments: boolean;
  commentModeration: 'off' | 'guests' | 'all';
  social: {
    twitter?: string | null;
    facebook?: string | null;
    discord?: string | null;
    youtube?: string | null;
  };
  seo: {
    defaultTitle: string;
    titleTemplate: string;
    defaultDescription: string;
    keywords: string;
  };
  analytics?: {
    googleAnalyticsId?: string | null;
    googleTagManagerId?: string | null;
    cloudflareWebAnalyticsToken?: string | null;
  };
  ads?: {
    adsenseClient?: string | null;
    adsenseSlotHeader?: string | null;
    adsenseSlotInFeed?: string | null;
    adsenseSlotInterstitial?: string | null;
    gamNetworkCode?: string | null;
    prebidEnabled?: boolean;
  };
};

export type AuthUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  locale: string;
  role: { slug: string; name: string; level: number };
  permissions: string[];
  xp: number;
  level: number;
  premium: boolean;
  twoFactorEnabled: boolean;
};

export type SessionPayload = {
  user: AuthUser;
  /** Short-lived JWT; the refresh token lives in an httpOnly cookie only. */
  accessToken: string;
  expiresAt: string;
};
