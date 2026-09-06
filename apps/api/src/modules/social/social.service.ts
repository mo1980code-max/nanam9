/**
 * Social: comments, votes, ratings, favourites, playlists and reports.
 *
 * The four rules that keep a public comment section usable:
 *
 * 1. GUESTS ARE PRE-MODERATED, MEMBERS ARE POST-MODERATED. A signed-in comment goes
 *    live immediately (and can be removed later); an anonymous one waits for a
 *    moderator. Competitors that let anonymous comments through unfiltered become
 *    a link farm within a week — and a link farm is an SEO penalty, not just noise.
 * 2. VOTES ARE WITHDRAWABLE AND COUNTED FROM THE TRUTH. `value: 0` removes a vote,
 *    and counters are recomputed from the `likes` table, so a like count can never
 *    drift from the rows behind it.
 * 3. REPORTS ARE IDEMPOTENT AND CONSEQUENTIAL. One reporter can only report a target
 *    once, and when a visible comment passes the auto-hide threshold it is hidden
 *    without waiting for a human — moderation queues are for judgement calls, not
 *    for stopping obvious abuse at 3am.
 * 4. THREADS ARE BOUNDED. Replies clamp at MAX_COMMENT_DEPTH instead of erroring:
 *    refusing to store a user's words because of a rendering constraint is the wrong
 *    trade, and an unbounded tree is a recursion bug waiting to happen.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CommentRow, Database, Page, PlaylistRow, RatingRow, ReportRow } from '@voltade/db';
import { CommentStatus, NotificationKind, PlaylistVisibility, ROLE_LEVELS, TargetKind, XP, slugify, type AuthUser } from '@voltade/shared';
import { AuditService } from '../../common/audit/audit.service.js';
import { DATABASE } from '../../common/database/database.module.js';
import { AppError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { absoluteUrl } from '../../common/http/urls.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { AchievementsService } from '../gamification/achievements.service.js';
import { GamesService, can } from '../games/games.service.js';
import type { GameCard } from '../games/game.presenter.js';
import {
  MAX_COMMENT_DEPTH,
  type CommentsQueryDto,
  type CreateCommentDto,
  type CreatePlaylistDto,
  type ModerateCommentDto,
  type PlaylistGameDto,
  type PlaylistGamesBulkDto,
  type RateDto,
  type ReportDto,
  type ReportsQueryDto,
  type ResolveReportDto,
  type UpdateCommentDto,
  type UpdatePlaylistDto,
  type VoteDto,
} from './dto/social.dto.js';

export type CommentAuthor = {
  id: string | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  level: number | null;
  staff: boolean;
};

export type CommentNode = {
  id: string;
  body: string;
  status: string;
  depth: number;
  likesCount: number;
  dislikesCount: number;
  reportsCount: number;
  createdAt: string;
  editedAt: string | null;
  author: CommentAuthor | null;
  /** Guest comments keep the name they typed; the email is never returned. */
  guestName: string | null;
  children: CommentNode[];
  viewerVote: 1 | -1 | null;
  canEdit: boolean;
  canDelete: boolean;
};

export type PlaylistView = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: string;
  coverUrl: string | null;
  gamesCount: number;
  shareUrl: string | null;
  owner: { id: string; username: string; displayName: string | null } | null;
  updatedAt: string;
  games?: GameCard[];
};

const AUTO_HIDE_REPORTS = 5;
const SPAM_THRESHOLD = 3;
const SPAM_PATTERNS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /(casino|poker|slot|betting|บาคาร่า|كازينو|قمار)/i, weight: 4, label: 'gambling keyword' },
  { pattern: /(viagra|cialis|pharmacy|cheap\s+meds|أدوية\s+رخيصة)/i, weight: 4, label: 'pharma keyword' },
  { pattern: /(buy\s+followers|increase\s+your\s+traffic|seo\s+services|شراء\s+متابعين)/i, weight: 3, label: 'seo spam' },
  { pattern: /(https?:\/\/\S+)/gi, weight: 2, label: 'links' },
  { pattern: /(.)\1{9,}/, weight: 1, label: 'repeated characters' },
  { pattern: /^.{0,2}$/, weight: 2, label: 'too short' },
];

@Injectable()
export class SocialService {
  private readonly logger = new Logger('social');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly achievements: AchievementsService,
    private readonly games: GamesService,
  ) {}

  // ── comments ─────────────────────────────────────────────────────────────

  async comments(meta: RequestMeta, query: CommentsQueryDto, viewer: AuthUser | null): Promise<{ items: CommentNode[]; total: number; page: Page }> {
    const gameId = query.game ? (await this.games.resolve(query.game)).id : undefined;
    const blogPostId = query.post ? await this.postId(query.post) : undefined;
    const isStaff = can(viewer, 'comments.moderate');

    const result = await this.db.social.listComments({
      gameId,
      blogPostId,
      parentId: query.parent || undefined,
      // The public always sees approved comments. A moderator may ask for a
      // specific queue, and "any" means no status filter at all.
      status: isStaff && query.status ? (query.status === 'any' ? undefined : query.status) : CommentStatus.visible,
      sort: (query.sort as 'newest' | 'oldest' | 'top') ?? 'top',
      tree: query.tree !== '0' && query.tree !== 'false',
      page: query.pageArg,
    });

    const votes = await this.votesForTree(viewer, result.items);
    const items = result.items.map((row) => this.commentNode(row, 0, votes, viewer, isStaff));
    return { items, total: result.total, page: query.pageArg };
  }

  async createComment(meta: RequestMeta, dto: CreateCommentDto, viewer: AuthUser | null): Promise<{ comment: CommentNode; xpAwarded: number; moderated: boolean; spamFlags: string[] }> {
    if (!viewer && !(dto.authorName?.trim())) {
      throw new AppError('comment.author_required', 'guest comments need a display name', 400);
    }
    if (!dto.game && !dto.post) throw new AppError('comment.target_required', 'a comment must target a game or a blog post', 400);

    const game = dto.game ? await this.games.resolve(dto.game) : null;
    const blogPostId = dto.post ? await this.postId(dto.post) : null;

    let parentId: string | null = dto.parent ?? null;
    let depth = 0;
    if (parentId) {
      const parent = await this.db.social.findCommentById(parentId);
      if (!parent || parent.status === CommentStatus.deleted) throw new AppError('comment.parent_not_found', 'the comment you are replying to no longer exists', 404);
      depth = await this.depthOf(parent) + 1;
      // Clamp rather than reject: the depth limit is a rendering constraint, and it
      // must never be the reason a user's words are thrown away. The reply stays in
      // the right thread; it is simply drawn at the deepest level the UI supports.
      if (depth >= MAX_COMMENT_DEPTH) depth = MAX_COMMENT_DEPTH - 1;
      if (game && parent.gameId && parent.gameId !== game.id) {
        throw new AppError('comment.target_mismatch', 'that reply belongs to a different game', 400);
      }
    }

    const spam = spamScore(dto.body);
    const status = decideStatus(viewer, spam);
    const row = await this.db.social.createComment({
      body: dto.body.trim(),
      gameId: game?.id ?? null,
      blogPostId,
      userId: viewer?.id ?? null,
      parentId,
      authorName: viewer ? null : dto.authorName?.trim() ?? null,
      authorEmail: viewer ? null : dto.authorEmail?.trim().toLowerCase() ?? null,
      authorIpHash: meta.ip ? hashIp(meta.ip) : null,
      status,
    });

    const progress = status === CommentStatus.visible && viewer
      ? await this.achievements.progress(viewer.id, { reason: 'comment.create', amount: XP.comment, metrics: ['comments'], targetKind: game ? 'game' : 'blog_post', targetId: game?.id ?? blogPostId })
      : null;

    // Tell the parent's author about the reply — the notification is the reason
    // threads keep going, and it must never fire for a reply to yourself.
    if (parentId && row.status !== CommentStatus.spam) {
      const parent = await this.db.social.findCommentById(parentId);
      if (parent?.userId && parent.userId !== row.userId) {
        await this.db.engagement.notify({
          userId: parent.userId,
          kind: NotificationKind.commentReply,
          title: 'رد جديد على تعليقك',
          body: row.body.slice(0, 140),
          link: game ? `/game/${game.slug}#comment-${row.id}` : null,
          data: { commentId: row.id, parentId: parent.id },
        });
      }
    }

    if (status !== CommentStatus.visible) {
      this.logger.log(`comment ${row.id} held as "${status}" (${spam.reasons.join(', ') || 'guest pre-moderation'})`);
    }
    this.audit.record(meta, { action: 'comment.create', targetKind: 'comment', targetId: row.id, after: { status, game: game?.slug ?? null, spam: spam.reasons } });

    return {
      comment: this.commentNode(row, depth, {}, viewer, can(viewer, 'comments.moderate')),
      xpAwarded: progress?.xpAwarded ?? 0,
      moderated: status !== CommentStatus.visible,
      spamFlags: spam.reasons,
    };
  }

  async updateComment(meta: RequestMeta, id: string, dto: UpdateCommentDto, viewer: AuthUser | null): Promise<CommentNode> {
    const existing = await this.db.social.findCommentById(id);
    if (!existing) throw new AppError('comment.not_found', 'no such comment', 404);
    const isModerator = can(viewer, 'comments.moderate');
    if (existing.userId !== viewer?.id && !isModerator) {
      throw new AppError('auth.forbidden', 'you can only edit your own comment', 403);
    }
    // A moderator edit is re-screened like any new text: the edit box is a spam
    // vector too, and "trusted author" must not mean "unfiltered content".
    const spam = spamScore(dto.body);
    if (spam.score >= SPAM_THRESHOLD) {
      throw new AppError('comment.spam', `the edited text was rejected (${spam.reasons.join(', ')})`, 422);
    }
    const updated = await this.db.social.updateComment(id, { body: dto.body.trim(), editedAt: new Date() });
    if (!updated) throw new AppError('comment.not_found', 'no such comment', 404);
    this.audit.record(meta, { action: isModerator && existing.userId !== viewer?.id ? 'comment.edit_by_moderator' : 'comment.edit', targetKind: 'comment', targetId: id, before: { body: existing.body }, after: { body: updated.body } });
    return this.commentNode(updated, 0, {}, viewer, isModerator);
  }

  async deleteComment(meta: RequestMeta, id: string, viewer: AuthUser | null, options: { hard?: boolean } = {}): Promise<{ deleted: boolean }> {
    const existing = await this.db.social.findCommentById(id);
    if (!existing) throw new AppError('comment.not_found', 'no such comment', 404);
    const isModerator = can(viewer, 'comments.delete');
    if (existing.userId !== viewer?.id && !isModerator) {
      throw new AppError('auth.forbidden', 'you can only delete your own comment', 403);
    }
    const deleted = await this.db.social.deleteComment(id, { hard: options.hard && isModerator });
    this.audit.record(meta, { action: 'comment.delete', targetKind: 'comment', targetId: id, before: { status: existing.status, hard: Boolean(options.hard && isModerator) } });
    return { deleted };
  }

  async moderateComment(meta: RequestMeta, id: string, dto: ModerateCommentDto): Promise<{ id: string; status: string }> {
    const existing = await this.db.social.findCommentById(id);
    if (!existing) throw new AppError('comment.not_found', 'no such comment', 404);
    const updated = await this.db.social.updateComment(id, { status: dto.status });
    this.audit.record(meta, { action: 'comment.moderate', targetKind: 'comment', targetId: id, before: { status: existing.status }, after: { status: dto.status } });
    return { id, status: updated?.status ?? dto.status };
  }

  // ── votes, ratings, favourites ───────────────────────────────────────────

  async vote(meta: RequestMeta, dto: VoteDto, viewer: AuthUser): Promise<{ value: 1 | -1 | 0; likes: number; dislikes: number }> {
    const targetId = await this.resolveTargetId(dto.target, dto.targetId);
    if (dto.value === 0) {
      await this.db.social.removeVote({ userId: viewer.id, targetKind: dto.target, targetId });
    } else {
      await this.db.social.vote({ userId: viewer.id, targetKind: dto.target, targetId, value: dto.value });
    }
    const counters = await this.countersFor(dto.target, targetId);

    // Reward the author of a liked comment — but never for liking their own.
    if (dto.target === TargetKind.comment && dto.value === 1) {
      const comment = await this.db.social.findCommentById(targetId);
      if (comment?.userId && comment.userId !== viewer.id) {
        await this.achievements.progress(comment.userId, { reason: 'comment.liked', amount: XP.commentLiked, targetKind: 'comment', targetId });
        await this.db.engagement.notify({
          userId: comment.userId,
          kind: NotificationKind.commentLike,
          title: 'أعجب أحدهم بتعليقك',
          body: comment.body.slice(0, 120),
          link: comment.gameId ? `/game/${await this.gameSlug(comment.gameId)}#comment-${comment.id}` : null,
        });
      }
    }
    void meta;
    return { value: dto.value, likes: counters.likes, dislikes: counters.dislikes };
  }

  async rate(meta: RequestMeta, dto: RateDto, viewer: AuthUser): Promise<{ rating: RatingRow; average: number; count: number; breakdown: { stars: number; count: number }[]; xpAwarded: number }> {
    const game = await this.games.resolve(dto.game);
    // "I changed my mind: 3 stars" must not delete the review they wrote last week.
    // Absent field → keep the stored text; an explicit empty string → clear it.
    const previous = await this.db.social.ratingFor(viewer.id, game.id);
    const review = dto.review === undefined ? previous?.review ?? null : dto.review.trim() || null;
    const rating = await this.db.social.rate({ userId: viewer.id, gameId: game.id, stars: dto.stars, review });
    const breakdown = await this.db.social.ratingBreakdown(game.id);
    const fresh = await this.db.catalog.findGameById(game.id, false);
    const progress = await this.achievements.progress(viewer.id, { reason: 'game.rate', amount: XP.rating, metrics: ['ratings'], targetKind: 'game', targetId: game.id });
    this.audit.record(meta, { action: 'game.rate', targetKind: 'game', targetId: game.id, after: { stars: dto.stars } });
    return {
      rating,
      average: fresh?.ratingAvg ?? rating.stars,
      count: fresh?.ratingCount ?? breakdown.reduce((sum, row) => sum + row.count, 0),
      breakdown,
      xpAwarded: progress.xpAwarded,
    };
  }

  async ratings(meta: RequestMeta, gameRef: string, page: Page): Promise<{ items: { stars: number; review: string | null; createdAt: string; author: { username: string; displayName: string | null; avatarUrl: string | null } | null }[]; total: number; average: number; count: number; breakdown: { stars: number; count: number }[] }> {
    const game = await this.games.resolve(gameRef);
    const result = await this.db.social.listRatings(game.id, page);
    const breakdown = await this.db.social.ratingBreakdown(game.id);
    void meta;
    return {
      items: result.items.map((rating) => ({
        stars: rating.stars,
        review: rating.review,
        createdAt: rating.createdAt.toISOString(),
        author: rating.user ? { username: rating.user.username, displayName: rating.user.displayName, avatarUrl: rating.user.avatarUrl ? absoluteUrl(rating.user.avatarUrl, this.config.apiPublicUrl) : null } : null,
      })),
      total: result.total,
      average: game.ratingAvg,
      count: game.ratingCount,
      breakdown,
    };
  }

  async toggleFavorite(meta: RequestMeta, gameRef: string, viewer: AuthUser): Promise<{ favorited: boolean; favoritesCount: number; xpAwarded: number }> {
    const game = await this.games.resolve(gameRef);
    const { favorited } = await this.db.social.toggleFavorite(viewer.id, game.id);
    const fresh = await this.db.catalog.findGameById(game.id, false);
    const progress = favorited
      ? await this.achievements.progress(viewer.id, { reason: 'game.favorite', amount: XP.favorite, metrics: ['favorites'], targetKind: 'game', targetId: game.id })
      : { xpAwarded: 0 };
    this.audit.record(meta, { action: favorited ? 'game.favorite' : 'game.unfavorite', targetKind: 'game', targetId: game.id });
    return { favorited, favoritesCount: fresh?.favoritesCount ?? game.favoritesCount, xpAwarded: progress.xpAwarded };
  }

  async favorites(meta: RequestMeta, viewer: AuthUser, page: Page): Promise<{ items: GameCard[]; total: number }> {
    const result = await this.db.social.listFavorites(viewer.id, page);
    return { items: this.games.cards(meta, result.items), total: result.total };
  }

  // ── playlists ────────────────────────────────────────────────────────────

  async createPlaylist(meta: RequestMeta, dto: CreatePlaylistDto, viewer: AuthUser): Promise<PlaylistView> {
    const slug = await this.uniquePlaylistSlug(dto.slug || dto.name, viewer.id);
    const row = await this.db.social.createPlaylist({
      userId: viewer.id,
      slug,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? null,
      visibility: dto.visibility ?? PlaylistVisibility.public,
    });
    for (const ref of dto.games ?? []) {
      const game = await this.games.resolve(ref).catch(() => null);
      if (game) await this.db.social.addGameToPlaylist(row.id, game.id);
    }
    await this.achievements.progress(viewer.id, { reason: 'playlist.create', amount: XP.playlist, metrics: ['playlists'], targetKind: null, targetId: row.id });
    this.audit.record(meta, { action: 'playlist.create', targetKind: 'playlist', targetId: row.id, after: { slug: row.slug, visibility: row.visibility } });
    return this.playlistView((await this.reload(row.id, viewer.id)) ?? row, viewer);
  }

  async playlists(meta: RequestMeta, viewer: AuthUser | null, ownerUsername?: string): Promise<PlaylistView[]> {
    const owner = ownerUsername ? await this.db.identity.findUserByUsername(ownerUsername) : viewer ? await this.db.identity.findUserById(viewer.id) : null;
    if (!owner) return [];
    const isSelf = viewer?.id === owner.id;
    const rows = await this.db.social.listPlaylists(owner.id);
    void meta;
    return rows
      .filter((row) => isSelf || can(viewer, 'users.view') || row.visibility !== PlaylistVisibility.private)
      .map((row) => this.playlistView(row, owner));
  }

  /** A playlist by id, slug or share token — the shareable-link path. */
  async playlist(meta: RequestMeta, idOrToken: string, viewer: AuthUser | null, options: { withGames?: boolean } = {}): Promise<PlaylistView> {
    const row = await this.db.social.findPlaylist(idOrToken, viewer?.id ?? null);
    if (!row) throw new AppError('playlist.not_found', 'no playlist matches that link', 404);
    const owner = await this.db.identity.findUserById(row.userId);
    const view = this.playlistView(row, owner);
    if (options.withGames !== false) {
      const games = await this.db.social.playlistGames(row.id);
      view.games = this.games.cards(meta, games);
    }
    return view;
  }

  async addToPlaylist(meta: RequestMeta, playlistRef: string, dto: PlaylistGameDto, viewer: AuthUser): Promise<{ added: boolean; gamesCount: number }> {
    const row = await this.ownedPlaylist(playlistRef, viewer);
    const game = await this.games.resolve(dto.game);
    const added = await this.db.social.addGameToPlaylist(row.id, game.id, dto.position);
    this.audit.record(meta, { action: 'playlist.add_game', targetKind: 'playlist', targetId: row.id, after: { game: game.slug } });
    const fresh = await this.reload(row.id, row.userId);
    return { added, gamesCount: fresh?.gamesCount ?? row.gamesCount };
  }

  async addManyToPlaylist(meta: RequestMeta, playlistRef: string, dto: PlaylistGamesBulkDto, viewer: AuthUser): Promise<{ added: number; gamesCount: number }> {
    const row = await this.ownedPlaylist(playlistRef, viewer);
    let added = 0;
    for (const ref of dto.games) {
      const game = await this.games.resolve(ref).catch(() => null);
      if (game && (await this.db.social.addGameToPlaylist(row.id, game.id))) added += 1;
    }
    this.audit.record(meta, { action: 'playlist.add_games', targetKind: 'playlist', targetId: row.id, after: { added } });
    const fresh = await this.reload(row.id, row.userId);
    return { added, gamesCount: fresh?.gamesCount ?? row.gamesCount };
  }

  async removeFromPlaylist(meta: RequestMeta, playlistRef: string, gameRef: string, viewer: AuthUser): Promise<{ removed: boolean; gamesCount: number }> {
    const row = await this.ownedPlaylist(playlistRef, viewer);
    const game = await this.games.resolve(gameRef, { publishedOnly: false });
    const removed = await this.db.social.removeGameFromPlaylist(row.id, game.id);
    this.audit.record(meta, { action: 'playlist.remove_game', targetKind: 'playlist', targetId: row.id, after: { game: game.slug } });
    const fresh = await this.reload(row.id, row.userId);
    return { removed, gamesCount: fresh?.gamesCount ?? row.gamesCount };
  }

  async updatePlaylist(meta: RequestMeta, playlistRef: string, dto: UpdatePlaylistDto, viewer: AuthUser): Promise<PlaylistView> {
    const row = await this.ownedPlaylist(playlistRef, viewer);
    const patch: Partial<PlaylistRow> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.visibility !== undefined) patch.visibility = dto.visibility;
    if (dto.coverUrl !== undefined) patch.coverUrl = dto.coverUrl;
    if (dto.slug !== undefined && dto.slug.trim() && dto.slug !== row.slug) patch.slug = await this.uniquePlaylistSlug(dto.slug, viewer.id, row.id);
    const updated = await this.db.social.updatePlaylist(row.id, patch);
    if (!updated) throw new AppError('playlist.not_found', 'no playlist matches that link', 404);
    this.audit.recordChange(meta, {
      action: 'playlist.update',
      targetKind: 'playlist',
      targetId: row.id,
      before: row as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return this.playlistView(updated, viewer);
  }

  async deletePlaylist(meta: RequestMeta, playlistRef: string, viewer: AuthUser): Promise<{ deleted: boolean }> {
    const row = await this.ownedPlaylist(playlistRef, viewer, { staffMayWrite: true });
    const deleted = await this.db.social.deletePlaylist(row.id);
    this.audit.record(meta, { action: 'playlist.delete', targetKind: 'playlist', targetId: row.id, before: { slug: row.slug } });
    return { deleted };
  }

  // ── reports ──────────────────────────────────────────────────────────────

  async report(meta: RequestMeta, dto: ReportDto, viewer: AuthUser | null): Promise<{ accepted: boolean; alreadyReported: boolean; autoHidden: boolean }> {
    const targetId = await this.resolveTargetId(dto.targetKind, dto.targetId);
    const existing = viewer ? await this.db.social.findReport(viewer.id, dto.targetKind, targetId) : null;
    if (existing) {
      // Idempotent: reporting twice must not inflate the counter that auto-hides.
      return { accepted: true, alreadyReported: true, autoHidden: false };
    }

    await this.db.social.createReport({
      reporterId: viewer?.id ?? null,
      targetKind: dto.targetKind,
      targetId,
      reason: dto.reason,
      details: dto.details?.trim() ?? null,
    });

    let autoHidden = false;
    if (dto.targetKind === TargetKind.comment) {
      const comment = await this.db.social.findCommentById(targetId);
      if (comment && comment.status === CommentStatus.visible && comment.reportsCount >= AUTO_HIDE_REPORTS) {
        await this.db.social.updateComment(targetId, { status: CommentStatus.hidden });
        autoHidden = true;
        this.audit.record(meta, { action: 'comment.auto_hidden', targetKind: 'comment', targetId, after: { reports: comment.reportsCount } });
      }
    }
    this.audit.record(meta, { action: 'report.create', targetKind: dto.targetKind, targetId, after: { reason: dto.reason, autoHidden } });
    return { accepted: true, alreadyReported: false, autoHidden };
  }

  async reports(meta: RequestMeta, query: ReportsQueryDto): Promise<{ items: ReportRow[]; total: number }> {
    void meta;
    const result = await this.db.social.listReports({
      status: query.status && query.status !== 'any' ? query.status : undefined,
      page: query.pageArg,
    });
    return { items: result.items, total: result.total };
  }

  async resolveReport(meta: RequestMeta, id: string, dto: ResolveReportDto, viewer: AuthUser): Promise<ReportRow | null> {
    const updated = await this.db.social.resolveReport(id, { moderatorId: viewer.id, status: dto.status, resolution: dto.resolution ?? null });
    this.audit.record(meta, { action: 'report.resolve', targetKind: 'report', targetId: id, after: { status: dto.status, resolution: dto.resolution ?? null } });
    return updated;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private commentNode(row: CommentRow, depth: number, votes: Record<string, 1 | -1>, viewer: AuthUser | null, isStaff: boolean): CommentNode {
    const author = row.user
      ? {
          id: row.user.id,
          username: row.user.username,
          displayName: row.user.displayName,
          avatarUrl: row.user.avatarUrl ? absoluteUrl(row.user.avatarUrl, this.config.apiPublicUrl) : null,
          level: null,
          staff: false,
        }
      : null;
    const isOwner = Boolean(viewer && row.userId === viewer.id);
    return {
      id: row.id,
      body: row.status === CommentStatus.deleted ? '' : row.body,
      status: row.status,
      depth,
      likesCount: row.likesCount,
      dislikesCount: row.dislikesCount,
      reportsCount: row.reportsCount,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      author,
      guestName: row.authorName,
      children: (row.children ?? []).map((child) => this.commentNode(child, depth + 1, votes, viewer, isStaff)),
      viewerVote: votes[row.id] ?? null,
      canEdit: isOwner || isStaff,
      canDelete: isOwner || isStaff,
    };
  }

  /** One vote lookup for the whole tree — a per-node query would be an N+1. */
  private async votesForTree(viewer: AuthUser | null, rows: CommentRow[]): Promise<Record<string, 1 | -1>> {
    if (!viewer) return {};
    const ids: string[] = [];
    const walk = (list: CommentRow[]): void => {
      for (const row of list) {
        ids.push(row.id);
        if (row.children?.length) walk(row.children);
      }
    };
    walk(rows);
    return ids.length ? this.db.social.votesFor(viewer.id, TargetKind.comment, ids) : {};
  }

  private async depthOf(row: CommentRow): Promise<number> {
    let depth = 0;
    let current = row;
    for (let guard = 0; guard < MAX_COMMENT_DEPTH + 4 && current.parentId; guard += 1) {
      const parent = await this.db.social.findCommentById(current.parentId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  private async resolveTargetId(kind: string, ref: string): Promise<string> {
    if (kind === TargetKind.game) return (await this.games.resolve(ref, { publishedOnly: false })).id;
    if (kind === TargetKind.blogPost) return this.postId(ref);
    if (kind === TargetKind.user) {
      const user = /^[a-zA-Z0-9]{20,32}$/.test(ref) ? await this.db.identity.findUserById(ref) : await this.db.identity.findUserByUsername(ref);
      if (!user) throw new AppError('user.not_found', 'no such user', 404);
      return user.id;
    }
    const comment = await this.db.social.findCommentById(ref);
    if (!comment) throw new AppError('comment.not_found', 'no such comment', 404);
    return comment.id;
  }

  private async postId(slugOrId: string): Promise<string> {
    const post = await this.db.content.findPostBySlug(slugOrId);
    if (post) return post.id;
    throw new AppError('post.not_found', `no blog post with the slug "${slugOrId}"`, 404);
  }

  private async countersFor(kind: string, targetId: string): Promise<{ likes: number; dislikes: number }> {
    if (kind === TargetKind.game) {
      const row = await this.db.catalog.findGameById(targetId, false);
      return { likes: row?.likesCount ?? 0, dislikes: row?.dislikesCount ?? 0 };
    }
    const row = await this.db.social.findCommentById(targetId);
    return { likes: row?.likesCount ?? 0, dislikes: row?.dislikesCount ?? 0 };
  }

  private async gameSlug(gameId: string): Promise<string> {
    const row = await this.db.catalog.findGameById(gameId, false);
    return row?.slug ?? '';
  }

  /**
   * Playlists are personal property: only the owner may edit one. Staff get a
   * separate, narrower door (deletePlaylist) so a moderator can take down an
   * abusive playlist without being able to quietly rewrite somebody's collection —
   * an admin who can edit any playlist is an admin who can be blamed for its contents.
   */
  private async ownedPlaylist(ref: string, viewer: AuthUser, options: { staffMayWrite?: boolean } = {}): Promise<PlaylistRow> {
    const row = await this.db.social.findPlaylist(ref, viewer.id);
    if (!row) throw new AppError('playlist.not_found', 'no playlist matches that link', 404);
    if (row.userId !== viewer.id && !(options.staffMayWrite && can(viewer, 'users.update'))) {
      throw new AppError('auth.forbidden', 'this playlist belongs to someone else', 403);
    }
    return row;
  }

  /** `findPlaylist` hides private playlists from anonymous callers, so reloading a
   *  playlist after a write must pass its owner — otherwise the fresh count is lost. */
  private async reload(id: string, ownerId: string): Promise<PlaylistRow | null> {
    return this.db.social.findPlaylist(id, ownerId);
  }

  private playlistView(row: PlaylistRow, owner: AuthUser | { id: string; username: string; displayName: string | null } | null): PlaylistView {
    const base = this.config.APP_URL.replace(/\/$/, '');
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      coverUrl: row.coverUrl ? absoluteUrl(row.coverUrl, this.config.apiPublicUrl) : null,
      gamesCount: row.gamesCount,
      // Only shareable links get a token URL; a private playlist has no public link.
      shareUrl: row.visibility === PlaylistVisibility.private ? null : `${base}/playlist/${row.shareToken ?? row.slug}`,
      owner: owner ? { id: owner.id, username: owner.username, displayName: (owner as { displayName?: string | null }).displayName ?? null } : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async uniquePlaylistSlug(input: string, userId: string, excludeId?: string): Promise<string> {
    const base = slugify(input, { max: 80 }) || 'playlist';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.db.social.findPlaylist(candidate, userId);
      if (!existing || existing.id === excludeId) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

/** Staff are a moderation target too, so the level check is explicit. */
export function isStaff(viewer: AuthUser | null): boolean {
  return Boolean(viewer && viewer.role.level >= ROLE_LEVELS.moderator);
}

function decideStatus(viewer: AuthUser | null, spam: { score: number; reasons: string[] }): string {
  if (spam.score >= SPAM_THRESHOLD + 2) return CommentStatus.spam;
  if (!viewer) return CommentStatus.pending; // guests: pre-moderated
  if (spam.score >= SPAM_THRESHOLD) return CommentStatus.pending;
  return CommentStatus.visible;
}

/** Cheap, explainable heuristics — the goal is to hold obvious spam for a human,
 *  not to judge nuance. False positives cost one approval click; false negatives
 *  cost the site's reputation and its search ranking. */
function spamScore(body: string): { score: number; reasons: string[] } {
  const text = body.trim();
  let score = 0;
  const reasons: string[] = [];
  for (const rule of SPAM_PATTERNS) {
    const matches = text.match(new RegExp(rule.pattern.source, rule.pattern.flags));
    if (!matches) continue;
    const weight = rule.label === 'links' ? rule.weight * Math.min(3, matches.length) : rule.weight;
    score += weight;
    reasons.push(rule.label === 'links' ? `${matches.length} link(s)` : rule.label);
  }
  // ALL-CAPS shouting (Latin text only; Arabic has no case).
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 20 && letters === letters.toUpperCase()) {
    score += 1;
    reasons.push('all caps');
  }
  return { score, reasons: [...new Set(reasons)] };
}

function hashIp(ip: string): string {
  // Hashed with a per-installation salt so a leak of the comments table cannot be
  // turned into a list of visitor IP addresses, while duplicate-spam detection by
  // IP still works.
  return createHash('sha256').update(`${ip}:${process.env.IP_SALT ?? 'voltade'}`).digest('hex').slice(0, 32);
}
