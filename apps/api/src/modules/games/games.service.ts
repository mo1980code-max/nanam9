/**
 * Games: the catalogue.
 *
 * This is the module the whole portal exists for, so the two decisions that shape
 * it are worth stating:
 *
 * 1. READ AND WRITE PATHS ARE SEPARATE. Public reads go through one method that
 *    always sets `publishedOnly` and always resolves the locale; admin reads go
 *    through another that may see drafts and soft-deleted rows. A single "list"
 *    method with an `isAdmin` flag is how unpublished games leak into a public
 *    JSON response — the flag gets forgotten once, and it is a data breach.
 *
 * 2. NOTHING THAT COSTS MONEY OR TRUST IS CLIENT-DECIDED. Play counts, XP and
 *    achievements are awarded here, from a server-side event, with anti-farm rules
 *    (XP only on the first play of a session). A client that could POST
 *    `{ plays: 1000 }` could top the leaderboard in an afternoon.
 *
 * Soft delete is the default everywhere: a game that is removed keeps its slug,
 * its analytics and its comments, and can be restored. Hard delete exists but is
 * gated behind a separate permission and an explicit `?hard=1`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database, GameRow, Page } from '@voltade/db';
import { GameStatus, ROLE_LEVELS, slugify, XP, type AuthUser, type Permission } from '@voltade/shared';
import { AuditService } from '../../common/audit/audit.service.js';
import { DATABASE } from '../../common/database/database.module.js';
import { AppError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { AchievementsService } from '../gamification/achievements.service.js';
import { GameListQueryDto, type AdminGameListQueryDto, type BulkGameActionDto, type CreateGameDto, type PlayEventDto, type UpdateGameDto } from './dto/game.dto.js';
import {
  anonymousViewerState,
  createGamePresenter,
  type GameCard,
  type GameDetail,
  type GameViewerState,
  type RelatedGame,
} from './game.presenter.js';

export type GameListResult = { items: GameCard[]; total: number; page: Page };

export type GameDetailResult = {
  game: GameDetail;
  related: RelatedGame[];
  viewer: GameViewerState;
  /** Breadcrumb path: root → ancestors → this game's category. */
  trail: { name: string; url: string }[];
};

export type PlayResult = {
  recorded: boolean;
  plays: number;
  uniquePlays: number;
  xpAwarded: number;
  xp: number;
  level: number;
  leveledUp: boolean;
  achievementsUnlocked: { slug: string; name: string; tier: string; xp: number }[];
};

const RELATED_LIMIT = 12;
/** How often one game may award XP to one player. See trackPlay(). */
const XP_COOLDOWN_MS = 5 * 60 * 1000;

@Injectable()
export class GamesService {
  private readonly logger = new Logger('games');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly achievements: AchievementsService,
  ) {}

  // ── public reads ─────────────────────────────────────────────────────────

  async list(meta: RequestMeta, query: GameListQueryDto): Promise<GameListResult> {
    const filter = query.toFilter();
    const result = await this.db.catalog.listGames({
      ...filter,
      // The public path can never see a draft, an archived game or a soft-deleted
      // one. It is set here rather than trusted from the query object.
      publishedOnly: true,
      locale: meta.locale,
      with: ['categories', 'tags'],
    });
    const presenter = this.presenter(meta);
    return { items: result.items.map((row) => presenter.card(row)), total: result.total, page: filter.page ?? query.pageArg };
  }

  async detail(meta: RequestMeta, slug: string, viewer: AuthUser | null): Promise<GameDetailResult> {
    const row = await this.db.catalog.findGameBySlug(slug, true);
    if (!row) throw this.notFound(slug);

    // A draft is a 404 to the public, not a 403: 403 confirms the slug exists,
    // which is exactly what a competitor scraping unreleased titles wants.
    if (!isPublished(row) && !can(viewer, 'games.view')) throw this.notFound(slug);

    const presenter = this.presenter(meta);
    const related = await this.db.catalog.relatedGames(row, RELATED_LIMIT);
    const state = await this.viewerState(row.id, viewer);
    return { game: presenter.detail(row), related: related.map((item) => presenter.related(item)), viewer: state, trail: this.trail(row) };
  }

  async search(meta: RequestMeta, term: string, query: GameListQueryDto): Promise<GameListResult> {
    // A spread would produce a plain object and lose `toFilter()`; copying onto a
    // fresh instance keeps the DTO's behaviour (and its validation guarantees).
    return this.list(meta, Object.assign(new GameListQueryDto(), query, { q: term }));
  }

  async related(meta: RequestMeta, slug: string, limit = RELATED_LIMIT): Promise<RelatedGame[]> {
    const row = await this.db.catalog.findGameBySlug(slug, false);
    if (!row || !isPublished(row)) throw this.notFound(slug);
    const items = await this.db.catalog.relatedGames(row, Math.min(48, Math.max(1, limit)));
    const presenter = this.presenter(meta);
    return items.map((item) => presenter.related(item));
  }

  async random(meta: RequestMeta, limit = 12, categorySlug?: string): Promise<GameCard[]> {
    const rows = await this.db.catalog.randomGames(Math.min(48, Math.max(1, limit)), categorySlug || undefined);
    const presenter = this.presenter(meta);
    return rows.map((row) => presenter.card(row));
  }

  /**
   * Record a play. Called by the game frame through the client once the iframe has
   * actually loaded — not on page view, so a bounce does not inflate the counter.
   */
  async trackPlay(meta: RequestMeta, dto: PlayEventDto, viewer: AuthUser | null): Promise<PlayResult> {
    const row = await this.findPlayable(dto.game);
    await this.db.engagement.recordPlay({
      gameId: row.id,
      userId: viewer?.id ?? null,
      sessionId: dto.sessionId ?? meta.playSessionId ?? null,
      device: dto.device ?? 'unknown',
      country: meta.country ?? null,
      referrer: meta.referer ?? null,
      utmSource: dto.utmSource ?? null,
      durationMs: dto.durationSeconds ? dto.durationSeconds * 1000 : null,
      completed: dto.completed ?? null,
    });

    const fresh = await this.db.catalog.findGameById(row.id, false);
    const result: PlayResult = {
      recorded: true,
      plays: fresh?.plays ?? row.plays + 1,
      uniquePlays: fresh?.uniquePlays ?? row.uniquePlays,
      xpAwarded: 0,
      xp: viewer?.xp ?? 0,
      level: viewer?.level ?? 1,
      leveledUp: false,
      achievementsUnlocked: [],
    };
    if (!viewer) return result;

    /*
     * ANTI-FARM: XP is awarded at most once per game per cooldown window.
     * "First play of session" is too strict here — the anonymous session cookie
     * lives 90 days, so a player would earn XP once a quarter. "Every play" is too
     * loose — reloading the page in a loop becomes an XP generator and the
     * leaderboard, which is the reason the profile page is worth visiting, turns
     * into noise. A short cooldown on the same game matches the intent: playing a
     * game earns points, refreshing it does not. Plays are still counted every time
     * (they are real page loads) and analytics use `unique_plays` for reach.
     */
    const history = await this.db.engagement.playHistory({ userId: viewer.id, gameId: row.id, page: { page: 1, perPage: 2, offset: 0 } });
    const previous = history.items[1]?.startedAt ?? null;
    if (previous && Date.now() - previous.getTime() < XP_COOLDOWN_MS) return result;

    // The same two rows answer "is this the first play today?" — a date comparison
    // instead of another aggregate over a table that grows with every session.
    const firstOfDay = !previous || previous.toDateString() !== new Date().toDateString();
    const progress = await this.achievements.progress(viewer.id, {
      reason: firstOfDay ? 'game.play.daily' : 'game.play',
      amount: firstOfDay ? XP.firstPlayOfDay : XP.play,
      metrics: ['plays'],
      targetKind: 'game',
      targetId: row.id,
    });

    result.xpAwarded = progress.xpAwarded;
    result.xp = progress.xp || viewer.xp + progress.xpAwarded;
    result.level = progress.level || viewer.level;
    result.leveledUp = progress.leveledUp;
    result.achievementsUnlocked = progress.unlocked.map(({ slug, name, tier, xp }) => ({ slug, name, tier, xp }));
    return result;
  }

  /** "Continue playing" for guests works off the anonymous session cookie. */
  async continuePlaying(meta: RequestMeta, viewer: AuthUser | null, limit = 8): Promise<GameCard[]> {
    const rows = await this.db.engagement.continuePlaying({
      userId: viewer?.id ?? null,
      sessionId: viewer ? null : meta.playSessionId ?? null,
      limit: Math.min(24, Math.max(1, limit)),
    });
    const presenter = this.presenter(meta);
    return rows.map((row) => presenter.card(row));
  }

  // ── admin reads and writes ───────────────────────────────────────────────

  async adminList(meta: RequestMeta, query: AdminGameListQueryDto): Promise<{ items: GameRow[]; total: number; page: Page }> {
    const filter = query.toFilter();
    const status = query.status === 'any' || !query.status ? undefined : query.status;
    const result = await this.db.catalog.listGames({
      ...filter,
      status,
      publishedOnly: false,
      includeDeleted: query.wantsDeleted,
      locale: meta.locale,
      with: ['categories', 'tags'],
    });
    return { items: result.items, total: result.total, page: filter.page ?? query.pageArg };
  }

  async adminOne(meta: RequestMeta, id: string): Promise<GameRow> {
    const row = await this.db.catalog.findGameById(id, true);
    if (!row) throw new AppError('game.not_found', `no game with id ${id}`, 404);
    void meta;
    return row;
  }

  async create(meta: RequestMeta, dto: CreateGameDto): Promise<GameRow> {
    // Arabic title first: the slug IS the keyword in an Arabic SEO strategy, and
    // transliterating it (سباق → sbaq) would throw the ranking signal away.
    const slug = await this.uniqueSlug(dto.slug || dto.title || dto.titleEn || '');
    const categories = await this.resolveCategories(dto.categories ?? []);
    const status = dto.status ?? 'draft';

    const row = await this.db.catalog.createGame({
      slug,
      title: dto.title.trim(),
      titleEn: dto.titleEn?.trim() ?? null,
      description: dto.description ?? null,
      descriptionEn: dto.descriptionEn ?? null,
      instructions: dto.instructions ?? null,
      developer: dto.developer ?? null,
      version: dto.version ?? null,
      releaseYear: dto.releaseYear ?? null,
      kind: dto.kind ?? 'iframe',
      url: dto.url.trim(),
      filePath: dto.filePath ?? null,
      thumbnailUrl: dto.thumbnailUrl ?? '',
      bannerUrl: dto.bannerUrl ?? null,
      gallery: dto.gallery ?? [],
      width: dto.width ?? null,
      height: dto.height ?? null,
      sizeKb: dto.sizeKb ?? null,
      orientation: dto.orientation ?? 'any',
      ageRating: dto.ageRating ?? 'everyone',
      status,
      featured: dto.featured ?? false,
      premium: dto.premium ?? false,
      publishedAt: publishDate(status, dto.publishedAt),
      seoTitle: dto.seo?.title ?? null,
      seoDescription: dto.seo?.description ?? null,
      seoKeywords: dto.seo?.keywords ?? null,
      canonicalUrl: dto.seo?.canonical ?? null,
      noindex: dto.seo?.noindex ?? status !== 'published',
      sourceHash: (dto.meta?.sourceHash as string | undefined) ?? null,
      providerSlug: dto.meta?.sourceHash ? 'upload' : null,
      meta: dto.meta ?? {},
      categories: categories.map((category) => ({ id: category.id, slug: category.slug, name: category.name })),
    });

    if (dto.tags?.length) await this.db.catalog.setGameTags(row.id, dto.tags);

    this.audit.record(meta, { action: 'game.create', targetKind: 'game', targetId: row.id, after: { slug: row.slug, title: row.title, status: row.status } });
    this.logger.log(`game created: ${row.slug} (${row.status}) by ${meta.actorLabel ?? 'unknown'}`);
    return (await this.db.catalog.findGameById(row.id, true)) ?? row;
  }

  async update(meta: RequestMeta, id: string, dto: UpdateGameDto): Promise<GameRow> {
    const existing = await this.db.catalog.findGameById(id, true);
    if (!existing) throw new AppError('game.not_found', `no game with id ${id}`, 404);

    const patch: Partial<GameRow> = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.titleEn !== undefined) patch.titleEn = dto.titleEn?.trim() ?? null;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.descriptionEn !== undefined) patch.descriptionEn = dto.descriptionEn;
    if (dto.instructions !== undefined) patch.instructions = dto.instructions;
    if (dto.developer !== undefined) patch.developer = dto.developer;
    if (dto.version !== undefined) patch.version = dto.version;
    if (dto.releaseYear !== undefined) patch.releaseYear = dto.releaseYear;
    if (dto.url !== undefined) patch.url = dto.url.trim();
    if (dto.filePath !== undefined) patch.filePath = dto.filePath;
    if (dto.thumbnailUrl !== undefined) patch.thumbnailUrl = dto.thumbnailUrl;
    if (dto.bannerUrl !== undefined) patch.bannerUrl = dto.bannerUrl;
    if (dto.gallery !== undefined) patch.gallery = dto.gallery;
    if (dto.width !== undefined) patch.width = dto.width;
    if (dto.height !== undefined) patch.height = dto.height;
    if (dto.sizeKb !== undefined) patch.sizeKb = dto.sizeKb;
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.orientation !== undefined) patch.orientation = dto.orientation;
    if (dto.ageRating !== undefined) patch.ageRating = dto.ageRating;
    if (dto.featured !== undefined) patch.featured = dto.featured;
    if (dto.premium !== undefined) patch.premium = dto.premium;
    if (dto.meta !== undefined) patch.meta = dto.meta;
    if (dto.seo) {
      if (dto.seo.title !== undefined) patch.seoTitle = dto.seo.title;
      if (dto.seo.description !== undefined) patch.seoDescription = dto.seo.description;
      if (dto.seo.keywords !== undefined) patch.seoKeywords = dto.seo.keywords;
      if (dto.seo.canonical !== undefined) patch.canonicalUrl = dto.seo.canonical;
      if (dto.seo.noindex !== undefined) patch.noindex = dto.seo.noindex;
    }

    if (dto.slug !== undefined && dto.slug.trim() && dto.slug !== existing.slug) {
      patch.slug = await this.uniqueSlug(dto.slug, id);
      // A slug change breaks every inbound link unless we keep a redirect. That is
      // the difference between an edit and a ranking loss.
      await this.db.operations.upsertRedirect({ sourcePath: `/game/${existing.slug}`, targetPath: `/game/${patch.slug}`, statusCode: 301 });
    }

    if (dto.status !== undefined && dto.status !== existing.status) {
      patch.status = dto.status;
      if (dto.status === 'published') {
        patch.publishedAt = dto.publishedAt ? new Date(dto.publishedAt) : existing.publishedAt ?? new Date();
        patch.noindex = dto.seo?.noindex ?? false;
      }
      if (dto.status === 'archived') patch.noindex = dto.seo?.noindex ?? true;
    } else if (dto.publishedAt !== undefined) {
      patch.publishedAt = new Date(dto.publishedAt);
    }

    if (dto.categories) {
      const categories = await this.resolveCategories(dto.categories);
      patch.categories = categories.map((category) => ({ id: category.id, slug: category.slug, name: category.name }));
    }
    const updated = await this.db.catalog.updateGame(id, patch);
    if (!updated) throw new AppError('game.not_found', `no game with id ${id}`, 404);
    // Tags are a relation, not a column: they are written through the join table.
    if (dto.tags) await this.db.catalog.setGameTags(id, dto.tags);

    this.audit.recordChange(meta, {
      action: 'game.update',
      targetKind: 'game',
      targetId: id,
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return (await this.db.catalog.findGameById(id, true)) ?? updated;
  }

  async remove(meta: RequestMeta, id: string, options: { hard?: boolean } = {}): Promise<{ deleted: boolean; hard: boolean }> {
    const existing = await this.db.catalog.findGameById(id, true);
    if (!existing) throw new AppError('game.not_found', `no game with id ${id}`, 404);
    const deleted = await this.db.catalog.deleteGame(id, { hard: options.hard });
    this.audit.record(meta, {
      action: options.hard ? 'game.delete_hard' : 'game.archive',
      targetKind: 'game',
      targetId: id,
      before: { slug: existing.slug, title: existing.title, status: existing.status },
    });
    return { deleted, hard: Boolean(options.hard) };
  }

  async restore(meta: RequestMeta, id: string): Promise<GameRow> {
    const existing = await this.db.catalog.findGameById(id, true);
    if (!existing) throw new AppError('game.not_found', `no game with id ${id}`, 404);
    const updated = await this.db.catalog.updateGame(id, { deletedAt: null, status: existing.publishedAt ? 'published' : 'draft' });
    if (!updated) throw new AppError('game.restore_failed', 'the game could not be restored', 500);
    this.audit.record(meta, { action: 'game.restore', targetKind: 'game', targetId: id, after: { status: updated.status } });
    return updated;
  }

  async bulkStatus(meta: RequestMeta, dto: BulkGameActionDto): Promise<{ updated: number; status: string }> {
    const status = dto.status ?? 'published';
    let updated = 0;
    for (const id of dto.ids) {
      const patch: Partial<GameRow> = { status };
      if (status === 'published') {
        const existing = await this.db.catalog.findGameById(id, false);
        if (!existing) continue;
        patch.publishedAt = existing.publishedAt ?? new Date();
        patch.deletedAt = null;
      }
      const result = await this.db.catalog.updateGame(id, patch);
      if (result) updated += 1;
    }
    this.audit.record(meta, { action: 'game.bulk_status', targetKind: 'game', after: { status, ids: dto.ids, updated } });
    return { updated, status };
  }

  /**
   * Persist a manual ordering inside one category — the drag-and-drop grid in the
   * admin panel. `position` already exists on category_game, so a curated category
   * page costs no extra table and no join: the public listing simply orders by it.
   */
  async reorderGames(meta: RequestMeta, categorySlug: string, ids: string[]): Promise<{ reordered: number; category: string }> {
    const category = await this.db.catalog.findCategoryBySlug(categorySlug);
    if (!category) throw new AppError('category.not_found', `no category with the slug "${categorySlug}"`, 404);
    await this.db.catalog.reorderCategoryGames(category.id, ids);
    this.audit.record(meta, { action: 'games.reorder', targetKind: 'category', targetId: category.id, after: { category: category.slug, ids } });
    return { reordered: ids.length, category: category.slug };
  }

  /** Re-derive every counter from the source tables. The button that fixes drift. */
  async recount(meta: RequestMeta, id?: string): Promise<{ recalculated: number }> {
    if (id) {
      await this.db.catalog.recalcGameCounters(id);
      this.audit.record(meta, { action: 'game.recount', targetKind: 'game', targetId: id });
      return { recalculated: 1 };
    }
    const listed = await this.db.catalog.listGames({ publishedOnly: false, includeDeleted: true, page: { page: 1, perPage: 1000, offset: 0 } });
    for (const row of listed.items) await this.db.catalog.recalcGameCounters(row.id);
    this.audit.record(meta, { action: 'game.recount_all', after: { count: listed.items.length } });
    return { recalculated: listed.items.length };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private presenter(meta: RequestMeta) {
    return createGamePresenter(meta.locale, this.config.apiPublicUrl);
  }

  /**
   * Resolve a slug-or-id reference to a game row. Sibling modules (social,
   * playlists, billing, imports) all accept "the thing in the URL" and must resolve
   * it with the SAME publication rules — a private helper per module is how a
   * playlist ends up containing an archived game.
   */
  async resolve(ref: string, options: { publishedOnly?: boolean } = {}): Promise<GameRow> {
    if (options.publishedOnly === false) {
      const row = (await this.db.catalog.findGameBySlug(ref, false)) ?? (await this.db.catalog.findGameById(ref, false));
      if (!row) throw new AppError('game.not_found', `no game matching "${ref}"`, 404);
      return row;
    }
    return this.findPlayable(ref);
  }

  /** Present rows as public cards — the shape every list endpoint returns. */
  cards(meta: RequestMeta, rows: GameRow[]): GameCard[] {
    const presenter = this.presenter(meta);
    return rows.map((row) => presenter.card(row));
  }

  private notFound(slug: string): AppError {
    return new AppError('game.not_found', `no published game with the slug "${slug}"`, 404);
  }

  private async findPlayable(slugOrId: string): Promise<GameRow> {
    const row = (await this.db.catalog.findGameBySlug(slugOrId, false)) ?? (await this.db.catalog.findGameById(slugOrId, false));
    if (!row) throw new AppError('game.not_found', `no game matching "${slugOrId}"`, 404);
    if (!isPublished(row)) throw new AppError('game.not_published', 'this game is not available to play yet', 403);
    return row;
  }

  private trail(row: GameRow): { name: string; url: string }[] {
    const category = row.categories?.[0];
    const trail = [{ name: 'الألعاب', url: '/games' }];
    if (category) trail.push({ name: category.name, url: `/category/${category.slug}` });
    trail.push({ name: row.title, url: `/game/${row.slug}` });
    return trail;
  }

  private async viewerState(gameId: string, viewer: AuthUser | null): Promise<GameViewerState> {
    if (!viewer) return anonymousViewerState;
    const favorite = await this.db.social.isFavorite(viewer.id, gameId);
    const rating = await this.db.social.ratingFor(viewer.id, gameId);
    const votes = await this.db.social.votesFor(viewer.id, 'game', [gameId]);
    const playlists = await this.db.social.playlistsContaining(viewer.id, gameId);
    const history = await this.db.engagement.playHistory({ userId: viewer.id, gameId, page: { page: 1, perPage: 2, offset: 0 } });
    const vote = votes[gameId];
    return {
      authenticated: true,
      favorite,
      rating: rating?.stars ?? null,
      review: rating?.review ?? null,
      vote: vote === 1 ? 'like' : vote === -1 ? 'dislike' : null,
      plays: history.total,
      lastPlayedAt: history.items[0]?.startedAt ? history.items[0].startedAt.toISOString() : null,
      playlists: playlists.map((playlist) => ({ id: playlist.id, slug: playlist.slug, title: playlist.name })),
    };
  }

  /** Slugs are unique forever; a taken slug gets a numeric suffix rather than an error. */
  private async uniqueSlug(input: string, excludeId?: string): Promise<string> {
    const base = slugify(input, { max: 90 }) || `game-${Date.now().toString(36)}`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.db.catalog.findGameBySlug(candidate, false);
      if (!existing || existing.id === excludeId) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  /** Categories referenced by slug are created if missing — an import must not fail
   *  because a publisher used a category we had not seeded. */
  private async resolveCategories(slugs: string[]): Promise<{ id: string; slug: string; name: string }[]> {
    const resolved: { id: string; slug: string; name: string }[] = [];
    for (const raw of slugs) {
      const slug = slugify(raw, { max: 90 });
      if (!slug) continue;
      const existing = await this.db.catalog.findCategoryBySlug(slug);
      if (existing) {
        resolved.push({ id: existing.id, slug: existing.slug, name: existing.name });
        continue;
      }
      const created = await this.db.catalog.createCategory({ slug, name: raw.trim() || slug });
      resolved.push({ id: created.id, slug: created.slug, name: created.name });
    }
    return resolved;
  }
}

function isPublished(row: GameRow): boolean {
  return row.status === 'published' && !row.deletedAt && (row.publishedAt === null || row.publishedAt.getTime() <= Date.now());
}

/**
 * Permission check with a level escape hatch: a super-admin's permission list is
 * materialised, but a freshly added permission must not lock the owner out of their
 * own portal before the RBAC sync has run.
 */
export function can(user: AuthUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.permissions.includes(permission)) return true;
  return user.role.level >= ROLE_LEVELS.admin;
}

function publishDate(status: string | undefined, value?: string): Date | null {
  if (value) return new Date(value);
  return status === 'published' ? new Date() : null;
}
