/**
 * SQL driver — social: comments, votes, ratings, favourites, playlists, reports.
 *
 * The counters live on the parent row and are updated in the same transaction as
 * the action that changed them. A read-modify-write in JavaScript would lose
 * updates the moment two players vote at once; `SET x = x + 1` inside the
 * transaction cannot.
 */

import { slugify } from '@voltade/shared';
import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type {
  CommentListFilter,
  CommentRow,
  FavoriteRow,
  GameRow,
  ID,
  List,
  PlaylistRow,
  RatingRow,
  ReportRow,
  SocialRepository,
} from '../../ports.js';
import { PgRepo, eq, inList, newId, pageOf, randomToken, toColumns } from './helpers.js';

const COMMENT_FIELDS = [
  'gameId',
  'blogPostId',
  'userId',
  'parentId',
  'authorName',
  'authorEmail',
  'authorIpHash',
  'body',
  'status',
  'editedAt',
  'deletedAt',
] as const;

const COMMENT_SELECT = `
  SELECT c.*,
         CASE WHEN u.id IS NULL THEN NULL
              ELSE jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'avatarUrl', u.avatar_url)
         END AS "userJson"
    FROM comments c
    LEFT JOIN users u ON u.id = c.user_id`;

export class PgSocialRepository extends PgRepo implements SocialRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  // ───────────────────────────── comments ─────────────────────────────

  async listComments(filter: CommentListFilter = {}): Promise<List<CommentRow>> {
    const conds: SqlPart[] = [sql`c.deleted_at IS NULL`];
    if (filter.gameId) conds.push(eq('c.game_id', filter.gameId)!);
    if (filter.blogPostId) conds.push(eq('c.blog_post_id', filter.blogPostId)!);
    if (filter.userId) conds.push(eq('c.user_id', filter.userId)!);
    if (filter.status) {
      const c = Array.isArray(filter.status) ? inList('c.status', filter.status) : eq('c.status', filter.status);
      if (c) conds.push(c);
    } else {
      conds.push(sql`c.status = 'visible'`);
    }
    // A thread page shows roots; replies come from the recursive CTE below.
    conds.push(filter.parentId === null ? sql`c.parent_id IS NULL` : filter.parentId ? eq('c.parent_id', filter.parentId)! : sql`c.parent_id IS NULL`);

    const where = resolvePart(sql.and(...conds));
    const page = pageOf(filter.page, 20);
    const orderBy =
      filter.sort === 'oldest'
        ? 'c.created_at ASC'
        : filter.sort === 'top'
          ? 'c.likes_count DESC, c.created_at DESC'
          : 'c.created_at DESC';

    const total = (await this.conn.value<number>(
      `SELECT count(*)::int FROM comments c WHERE ${where.text}`,
      where.values,
    )) ?? 0;

    const roots = await this.conn.many<CommentRow & { userJson?: unknown }>(
      `${COMMENT_SELECT} WHERE ${where.text} ORDER BY ${orderBy} LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, page.perPage, page.offset],
    );

    const items = roots.map(mapComment);
    if (filter.tree !== false && items.length > 0) {
      const descendants = await this.conn.many<CommentRow & { userJson?: unknown }>(
        `WITH RECURSIVE thread AS (
             SELECT c.* FROM comments c WHERE c.parent_id = ANY($1) AND c.deleted_at IS NULL AND c.status = 'visible'
           UNION ALL
             SELECT c2.* FROM comments c2 JOIN thread t ON c2.parent_id = t.id
             WHERE c2.deleted_at IS NULL AND c2.status = 'visible'
         )
         SELECT t.*,
                CASE WHEN u.id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'avatarUrl', u.avatar_url)
                END AS "userJson"
           FROM thread t LEFT JOIN users u ON u.id = t.user_id
          ORDER BY t.created_at ASC`,
        [items.map((i) => i.id)],
      );
      // Map the descendants ONCE. Mapping twice produced two distinct objects per
      // row: the index held the first copy while the linking loop walked the
      // second, so a grandchild was attached to an orphaned object and every
      // thread came back one level deep instead of two.
      const mapped = descendants.map(mapComment);
      const byId = new Map<ID, CommentRow>(items.map((i) => [i.id, i]));
      for (const d of mapped) byId.set(d.id, d);
      for (const d of mapped) {
        const parent = d.parentId ? byId.get(d.parentId) : undefined;
        if (parent && parent !== d) {
          parent.children ??= [];
          if (!parent.children.some((c) => c.id === d.id)) parent.children.push(d);
        }
      }
    }
    return { items, total };
  }

  async findCommentById(id: ID): Promise<CommentRow | null> {
    const row = await this.conn.one<CommentRow & { userJson?: unknown }>(`${COMMENT_SELECT} WHERE c.id = $1`, [id]);
    return row ? mapComment(row) : null;
  }

  async createComment(data: Partial<CommentRow> & { body: string }): Promise<CommentRow> {
    const columns = toColumns(data, COMMENT_FIELDS);
    columns.id = data.id ?? newId();
    columns.updated_at = new Date();
    const row = await this.insert<CommentRow>('comments', columns);
    if (row.gameId) {
      await this.conn.run(`UPDATE games SET comments_count = comments_count + 1 WHERE id = $1`, [row.gameId]);
    }
    if (row.userId) {
      await this.conn.run(`UPDATE users SET comments_count = comments_count + 1 WHERE id = $1`, [row.userId]);
    }
    return (await this.findCommentById(row.id)) ?? row;
  }

  async updateComment(id: ID, patch: Partial<CommentRow>): Promise<CommentRow | null> {
    const columns = toColumns(patch, [...COMMENT_FIELDS, 'likesCount', 'dislikesCount', 'reportsCount']);
    if (Object.keys(columns).length > 0) {
      columns.updated_at = new Date();
      if (patch.body && !patch.editedAt) columns.edited_at = new Date();
      await this.update('comments', 'id', id, columns);
    }
    return this.findCommentById(id);
  }

  async deleteComment(id: ID, options: { hard?: boolean } = {}): Promise<boolean> {
    const comment = await this.findCommentById(id);
    if (!comment) return false;
    if (options.hard) {
      await this.conn.run(`DELETE FROM comments WHERE id = $1`, [id]);
    } else {
      await this.conn.run(`UPDATE comments SET deleted_at = now(), status = 'deleted' WHERE id = $1`, [id]);
    }
    if (comment.gameId) {
      await this.conn.run(
        `UPDATE games SET comments_count = GREATEST(0, (SELECT count(*)::int FROM comments WHERE game_id = $1 AND status = 'visible' AND deleted_at IS NULL)) WHERE id = $1`,
        [comment.gameId],
      );
    }
    return true;
  }

  async countCommentsByStatus(): Promise<Record<string, number>> {
    const rows = await this.conn.many<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM comments WHERE deleted_at IS NULL GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }

  // ─────────────────────────────── votes ───────────────────────────────

  async vote(input: { userId: ID; targetKind: string; targetId: string; value: 1 | -1 }): Promise<{ value: 1 | -1; changed: boolean }> {
    const previous = await this.conn.one<{ value: number }>(
      `SELECT value FROM likes WHERE user_id = $1 AND target_kind = $2 AND target_id = $3`,
      [input.userId, input.targetKind, input.targetId],
    );
    const changed = previous?.value !== input.value;
    await this.conn.run(
      `INSERT INTO likes (id, user_id, target_kind, target_id, value, created_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (user_id, target_kind, target_id) DO UPDATE SET value = EXCLUDED.value`,
      [newId(), input.userId, input.targetKind, input.targetId, input.value],
    );
    if (changed) await this.syncVoteCounters(input.targetKind, input.targetId);
    return { value: input.value, changed };
  }

  async removeVote(input: { userId: ID; targetKind: string; targetId: string }): Promise<boolean> {
    const removed = (await this.conn.run(`DELETE FROM likes WHERE user_id = $1 AND target_kind = $2 AND target_id = $3`, [
      input.userId,
      input.targetKind,
      input.targetId,
    ])) > 0;
    if (removed) await this.syncVoteCounters(input.targetKind, input.targetId);
    return removed;
  }

  /** Recounts from the votes table — the counter can never drift from the truth. */
  private async syncVoteCounters(targetKind: string, targetId: string): Promise<void> {
    if (targetKind === 'game') {
      await this.conn.run(
        `UPDATE games SET
            likes_count = (SELECT count(*)::int FROM likes WHERE target_kind='game' AND target_id=$1 AND value=1),
            dislikes_count = (SELECT count(*)::int FROM likes WHERE target_kind='game' AND target_id=$1 AND value=-1)
          WHERE id = $1`,
        [targetId],
      );
    } else if (targetKind === 'comment') {
      await this.conn.run(
        `UPDATE comments SET
            likes_count = (SELECT count(*)::int FROM likes WHERE target_kind='comment' AND target_id=$1 AND value=1),
            dislikes_count = (SELECT count(*)::int FROM likes WHERE target_kind='comment' AND target_id=$1 AND value=-1)
          WHERE id = $1`,
        [targetId],
      );
    }
  }

  async votesFor(userId: ID | null, targetKind: string, targetIds: ID[]): Promise<Record<ID, 1 | -1>> {
    if (!userId || targetIds.length === 0) return {};
    const rows = await this.conn.many<{ targetId: ID; value: number }>(
      `SELECT target_id AS "targetId", value FROM likes WHERE user_id = $1 AND target_kind = $2 AND target_id = ANY($3)`,
      [userId, targetKind, targetIds],
    );
    return Object.fromEntries(rows.map((r) => [r.targetId, r.value as 1 | -1]));
  }

  // ────────────────────────────── ratings ──────────────────────────────

  async rate(input: { userId: ID; gameId: ID; stars: number; review?: string | null }): Promise<RatingRow> {
    const stars = Math.min(5, Math.max(1, Math.round(input.stars)));
    await this.conn.run(
      `INSERT INTO ratings (id, user_id, game_id, stars, review, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,now(),now())
       ON CONFLICT (user_id, game_id) DO UPDATE SET stars = EXCLUDED.stars, review = EXCLUDED.review, updated_at = now()`,
      [newId(), input.userId, input.gameId, stars, input.review ?? null],
    );
    // One statement keeps rating_avg and rating_count consistent with each other.
    await this.conn.run(
      `UPDATE games SET
          rating_count = (SELECT count(*)::int FROM ratings WHERE game_id = $1),
          rating_avg = coalesce((SELECT round(avg(stars)::numeric, 3)::real FROM ratings WHERE game_id = $1), 0)
        WHERE id = $1`,
      [input.gameId],
    );
    const row = await this.ratingFor(input.userId, input.gameId);
    if (!row) throw new Error('rate: rating disappeared after upsert');
    return row;
  }

  async ratingFor(userId: ID | null, gameId: ID): Promise<RatingRow | null> {
    if (!userId) return null;
    return this.conn.one<RatingRow>(`SELECT * FROM ratings WHERE user_id = $1 AND game_id = $2`, [userId, gameId]);
  }

  async listRatings(gameId: ID, page?: { page: number; perPage: number; offset: number }): Promise<List<RatingRow>> {
    const p = pageOf(page, 10);
    // The count uses the SAME predicate as the page: this list is the written
    // reviews (star-only ratings still count towards rating_avg, they just have
    // nothing to render). A total that counts more rows than the filter can ever
    // return produces a pager with permanently empty last pages.
    const total = (await this.conn.value<number>(
      `SELECT count(*)::int FROM ratings WHERE game_id = $1 AND review IS NOT NULL AND length(btrim(review)) > 0`,
      [gameId],
    )) ?? 0;
    const items = await this.conn.many<RatingRow>(
      `SELECT r.*, jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'avatarUrl', u.avatar_url) AS user
         FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.game_id = $1 AND r.review IS NOT NULL AND length(btrim(r.review)) > 0
        ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [gameId, p.perPage, p.offset],
    );
    return { items: items.map((r) => ({ ...r, user: flattenUser(r.user as unknown as Record<string, unknown>) })), total };
  }

  async ratingBreakdown(gameId: ID): Promise<{ stars: number; count: number }[]> {
    const rows = await this.conn.many<{ stars: number; count: number }>(
      `SELECT stars, count(*)::int AS count FROM ratings WHERE game_id = $1 GROUP BY stars ORDER BY stars DESC`,
      [gameId],
    );
    return [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: rows.find((r) => r.stars === s)?.count ?? 0 }));
  }

  // ───────────────────────────── favourites ─────────────────────────────

  async toggleFavorite(userId: ID, gameId: ID): Promise<{ favorited: boolean }> {
    const existing = await this.conn.one<FavoriteRow>(`SELECT * FROM favorites WHERE user_id = $1 AND game_id = $2`, [userId, gameId]);
    if (existing) {
      await this.conn.run(`DELETE FROM favorites WHERE id = $1`, [existing.id]);
    } else {
      await this.conn.run(`INSERT INTO favorites (id, user_id, game_id, created_at) VALUES ($1,$2,$3,now())`, [
        newId(),
        userId,
        gameId,
      ]);
    }
    await this.conn.run(
      `UPDATE games SET favorites_count = (SELECT count(*)::int FROM favorites WHERE game_id = $1) WHERE id = $1`,
      [gameId],
    );
    return { favorited: !existing };
  }

  async listFavorites(userId: ID, page?: { page: number; perPage: number; offset: number }): Promise<List<GameRow>> {
    const p = pageOf(page);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM favorites WHERE user_id = $1`, [userId])) ?? 0;
    const items = await this.conn.many<GameRow>(
      `SELECT g.* FROM favorites f JOIN games g ON g.id = f.game_id
        WHERE f.user_id = $1 AND g.deleted_at IS NULL
        ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`,
      [userId, p.perPage, p.offset],
    );
    return { items, total };
  }

  async isFavorite(userId: ID | null, gameId: ID): Promise<boolean> {
    if (!userId) return false;
    return ((await this.conn.value<number>(`SELECT count(*)::int FROM favorites WHERE user_id = $1 AND game_id = $2`, [userId, gameId])) ?? 0) > 0;
  }

  // ────────────────────────────── playlists ──────────────────────────────

  async createPlaylist(data: { userId: ID; slug: string; name: string; description?: string | null; visibility?: string }): Promise<PlaylistRow> {
    return this.insert<PlaylistRow>('playlists', {
      id: newId(),
      user_id: data.userId,
      slug: slugify(data.slug || data.name) || `list-${Date.now().toString(36)}`,
      name: data.name,
      description: data.description ?? null,
      visibility: data.visibility ?? 'private',
      games_count: 0,
      share_token: data.visibility === 'unlisted' ? randomToken() : null,
      updated_at: new Date(),
    });
  }

  async listPlaylists(userId: ID): Promise<PlaylistRow[]> {
    return this.conn.many<PlaylistRow>(`SELECT * FROM playlists WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
  }

  async findPlaylist(idOrToken: string, userId?: ID | null): Promise<PlaylistRow | null> {
    const values: unknown[] = [idOrToken];
    let scope = '';
    if (userId) {
      scope = `AND (p.visibility <> 'private' OR p.user_id = $2)`;
      values.push(userId);
    } else {
      scope = `AND p.visibility = 'public'`;
    }
    return this.conn.one<PlaylistRow>(
      `SELECT p.* FROM playlists p WHERE (p.id = $1 OR p.share_token = $1 OR p.slug = $1) ${scope} LIMIT 1`,
      values,
    );
  }

  async addGameToPlaylist(playlistId: ID, gameId: ID, position?: number): Promise<boolean> {
    const pos = position ?? ((await this.conn.value<number>(`SELECT coalesce(max(position), -1) + 1 FROM playlist_game WHERE playlist_id = $1`, [playlistId])) ?? 0);
    // The affected-row count is the answer: ON CONFLICT DO NOTHING reports 0 when
    // the game was already in the playlist. Returning a hardcoded `true` here made
    // every "add" look successful, so a client could never tell a real add from a
    // duplicate and the UI would happily show a toast for a no-op.
    const inserted = (await this.conn.run(
      `INSERT INTO playlist_game (playlist_id, game_id, position, created_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (playlist_id, game_id) DO NOTHING`,
      [playlistId, gameId, pos],
    )) > 0;
    if (inserted) await this.syncPlaylistCount(playlistId);
    return inserted;
  }

  async removeGameFromPlaylist(playlistId: ID, gameId: ID): Promise<boolean> {
    const removed = (await this.conn.run(`DELETE FROM playlist_game WHERE playlist_id = $1 AND game_id = $2`, [playlistId, gameId])) > 0;
    if (removed) await this.syncPlaylistCount(playlistId);
    return removed;
  }

  async playlistGames(playlistId: ID): Promise<GameRow[]> {
    return this.conn.many<GameRow>(
      `SELECT g.* FROM playlist_game pg JOIN games g ON g.id = pg.game_id
        WHERE pg.playlist_id = $1 AND g.deleted_at IS NULL ORDER BY pg.position, pg.created_at`,
      [playlistId],
    );
  }

  async playlistsContaining(userId: ID, gameId: ID): Promise<PlaylistRow[]> {
    return this.conn.many<PlaylistRow>(
      `SELECT p.* FROM playlists p JOIN playlist_game pg ON pg.playlist_id = p.id
        WHERE p.user_id = $1 AND pg.game_id = $2 ORDER BY p.updated_at DESC`,
      [userId, gameId],
    );
  }

  async updatePlaylist(id: ID, patch: Partial<PlaylistRow>): Promise<PlaylistRow | null> {
    await this.update('playlists', 'id', id, { ...toColumns(patch, ['name', 'slug', 'description', 'visibility', 'coverUrl', 'shareToken']), updated_at: new Date() });
    return this.conn.one<PlaylistRow>(`SELECT * FROM playlists WHERE id = $1`, [id]);
  }

  async deletePlaylist(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM playlists WHERE id = $1`, [id])) > 0;
  }

  private async syncPlaylistCount(playlistId: ID): Promise<void> {
    await this.conn.run(
      `UPDATE playlists SET games_count = (SELECT count(*)::int FROM playlist_game WHERE playlist_id = $1), updated_at = now() WHERE id = $1`,
      [playlistId],
    );
  }

  // ─────────────────────────────── reports ───────────────────────────────

  async createReport(data: { reporterId?: ID | null; targetKind: string; targetId: string; reason: string; details?: string | null }): Promise<ReportRow> {
    const row = await this.insert<ReportRow>('reports', {
      id: newId(),
      reporter_id: data.reporterId ?? null,
      target_kind: data.targetKind,
      target_id: data.targetId,
      reason: data.reason,
      details: data.details ?? null,
      status: 'open',
    });
    if (data.targetKind === 'comment') {
      await this.conn.run(`UPDATE comments SET reports_count = reports_count + 1 WHERE id = $1`, [data.targetId]);
    }
    return row;
  }

  async findReport(reporterId: ID, targetKind: string, targetId: string): Promise<ReportRow | null> {
    return this.conn.one<ReportRow>(
      `SELECT * FROM reports WHERE reporter_id = $1 AND target_kind = $2 AND target_id = $3 LIMIT 1`,
      [reporterId, targetKind, targetId],
    );
  }

  async listReports(filter: { status?: string; page?: { page: number; perPage: number; offset: number } } = {}): Promise<List<ReportRow>> {
    const conds: SqlPart[] = [];
    if (filter.status) conds.push(eq('r.status', filter.status)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 25);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM reports r WHERE ${where.text}`, where.values)) ?? 0;
    const items = await this.conn.many<ReportRow>(
      `SELECT r.*, ru.username AS "reporterName", mu.username AS "moderatorName"
         FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id LEFT JOIN users mu ON mu.id = r.moderator_id
        WHERE ${where.text} ORDER BY r.created_at DESC LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items, total };
  }

  async resolveReport(id: ID, input: { moderatorId: ID; status: string; resolution?: string | null }): Promise<ReportRow | null> {
    return this.update<ReportRow>('reports', 'id', id, {
      status: input.status,
      moderator_id: input.moderatorId,
      resolution: input.resolution ?? null,
      resolved_at: new Date(),
    });
  }
}

function mapComment(row: CommentRow & { userJson?: unknown }): CommentRow {
  const { userJson, ...rest } = row as CommentRow & { userJson?: Record<string, unknown> | null };
  return { ...rest, user: userJson ? flattenUser(userJson) : null, children: rest.children ?? [] };
}

function flattenUser(raw: Record<string, unknown> | null | undefined) {
  if (!raw) return null;
  return {
    id: (raw.id as string) ?? null,
    username: (raw.username as string) ?? 'guest',
    displayName: (raw.displayName as string | null) ?? null,
    avatarUrl: (raw.avatarUrl as string | null) ?? null,
  };
}

