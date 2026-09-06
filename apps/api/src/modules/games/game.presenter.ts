/**
 * The public shape of a game.
 *
 * WHY A PRESENTER AND NOT RAW ROWS: the database row is an internal contract — it
 * carries `deletedAt`, `sourceHash`, provider internals and both locales of every
 * text field. Handing that to a browser would leak unpublished data and force every
 * client to re-implement "which title do I show in Arabic?". So the API publishes ONE
 * shape, locale-resolved, with absolute media URLs, and the Next.js app renders it
 * without knowing the schema.
 *
 * Two sizes on purpose:
 *  - `card`   — everything a grid tile needs (cheap, no long text)
 *  - `detail` — the game page (adds description, instructions, gallery, SEO)
 * Keeping them separate is what lets the catalogue stay fast at 20k games: a list
 * never pays to serialise a description it will not render.
 *
 * Viewer state is a SEPARATE object. Mixing "is this my favourite?" into the game
 * payload would make every response uncacheable; keeping it out means the CDN can
 * cache the game for everyone and the client merges its own state on top.
 */

import type { GameRow } from '@voltade/db';
import type { Locale } from '@voltade/shared';
import { absoluteUrl, localized } from '../../common/http/urls.js';

export type GameCard = {
  id: string;
  slug: string;
  title: string;
  titleEn: string | null;
  thumbnailUrl: string;
  kind: string;
  orientation: string;
  ageRating: string;
  featured: boolean;
  premium: boolean;
  plays: number;
  likesCount: number;
  dislikesCount: number;
  ratingAvg: number;
  ratingCount: number;
  commentsCount: number;
  width: number | null;
  height: number | null;
  publishedAt: string | null;
  categories: { slug: string; name: string }[];
  tags: { slug: string; name: string }[];
};

export type GameDetail = GameCard & {
  description: string | null;
  instructions: string | null;
  developer: string | null;
  version: string | null;
  releaseYear: number | null;
  url: string;
  filePath: string | null;
  bannerUrl: string | null;
  gallery: string[];
  sizeKb: number | null;
  favoritesCount: number;
  uniquePlays: number;
  source: string | null;
  status: string;
  updatedAt: string;
  seo: { title: string; description: string | null; keywords: string | null; canonical: string | null; noindex: boolean };
};

/** Per-viewer state: never mixed into the cacheable public payload. */
export type GameViewerState = {
  authenticated: boolean;
  favorite: boolean;
  rating: number | null;
  review: string | null;
  vote: 'like' | 'dislike' | null;
  plays: number;
  lastPlayedAt: string | null;
  playlists: { id: string; slug: string; title: string }[];
};

export const anonymousViewerState: GameViewerState = {
  authenticated: false,
  favorite: false,
  rating: null,
  review: null,
  vote: null,
  plays: 0,
  lastPlayedAt: null,
  playlists: [],
};

export type RelatedGame = Pick<GameCard, 'id' | 'slug' | 'title' | 'thumbnailUrl' | 'ratingAvg' | 'ratingCount' | 'plays'>;

export type GamePresenter = {
  readonly locale: Locale;
  card(row: GameRow): GameCard;
  detail(row: GameRow): GameDetail;
  related(row: GameRow): RelatedGame;
  url(value: string | null | undefined): string | null;
};

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * Bound to one request's locale and one base URL, so handlers stay readable:
 * `presenter.card(row)` instead of `toCard(row, locale, base)` in a dozen places.
 */
export function createGamePresenter(locale: Locale, base: string): GamePresenter {
  const url = (value: string | null | undefined): string | null => absoluteUrl(value, base);

  const card = (row: GameRow): GameCard => ({
    id: row.id,
    slug: row.slug,
    title: localized(row.title, row.titleEn, locale) ?? row.title,
    titleEn: row.titleEn,
    thumbnailUrl: url(row.thumbnailUrl) ?? '',
    kind: row.kind,
    orientation: row.orientation,
    ageRating: row.ageRating,
    featured: row.featured,
    premium: row.premium,
    plays: row.plays,
    likesCount: row.likesCount,
    dislikesCount: row.dislikesCount,
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
    commentsCount: row.commentsCount,
    width: row.width,
    height: row.height,
    publishedAt: iso(row.publishedAt),
    categories: (row.categories ?? []).map((category) => ({ slug: category.slug, name: category.name })),
    tags: (row.tags ?? []).map((tag) => ({ slug: tag.slug, name: tag.name })),
  });

  const detail = (row: GameRow): GameDetail => {
    const base = card(row);
    const description = localized(row.description, row.descriptionEn, locale);
    return {
      ...base,
      description,
      instructions: row.instructions,
      developer: row.developer,
      version: row.version,
      releaseYear: row.releaseYear,
      url: url(row.url) ?? '',
      filePath: row.filePath,
      bannerUrl: url(row.bannerUrl),
      gallery: (row.gallery ?? []).map((item) => url(item)).filter((item): item is string => Boolean(item)),
      sizeKb: row.sizeKb,
      favoritesCount: row.favoritesCount,
      uniquePlays: row.uniquePlays,
      source: row.providerSlug,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
      seo: {
        title: row.seoTitle ?? base.title,
        description: row.seoDescription ?? description,
        keywords: row.seoKeywords ?? null,
        canonical: row.canonicalUrl ?? null,
        noindex: row.noindex,
      },
    };
  };

  const related = (row: GameRow): RelatedGame => {
    const item = card(row);
    return {
      id: item.id,
      slug: item.slug,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      ratingAvg: item.ratingAvg,
      ratingCount: item.ratingCount,
      plays: item.plays,
    };
  };

  return { locale, card, detail, related, url };
}
