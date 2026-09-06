/**
 * SQL driver — engagement: plays, analytics rollups, achievements, XP, notifications.
 *
 * The dashboard never scans `game_plays` for a long range: `rollupDailyStats`
 * folds raw plays into `daily_stats` (one row per day per dimension) and the
 * charts read that. A year of history is then a few thousand rows, not millions.
 */

import type { Connection } from '../../connection.js';
import { XP } from '@voltade/shared';
import type {
  AchievementRow,
  DashboardStats,
  EngagementRepository,
  GamePlayRow,
  GameRow,
  ID,
  List,
  NotificationRow,
  StatsRange,
  UserActionCounts,
} from '../../ports.js';
import { PgRepo, newId, pageOf } from './helpers.js';

const DAY_MS = 86_400_000;

export class PgEngagementRepository extends PgRepo implements EngagementRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  async recordPlay(input: {
    gameId: ID;
    userId?: ID | null;
    sessionId?: string | null;
    device?: string;
    country?: string | null;
    referrer?: string | null;
    utmSource?: string | null;
    at?: Date | null;
    durationMs?: number | null;
    completed?: boolean | null;
  }): Promise<{ firstPlayOfSession: boolean }> {
    const firstPlayOfSession =
      ((await this.conn.value<number>(
        `SELECT count(*)::int FROM game_plays WHERE game_id = $1 AND (session_id = $2 OR ($2 IS NULL AND user_id = $3))`,
        [input.gameId, input.sessionId ?? null, input.userId ?? null],
      )) ?? 0) === 0;

    await this.conn.run(
      `INSERT INTO game_plays (game_id, user_id, session_id, device, country, referrer, utm_source, started_at, duration_ms, completed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8, now()), $9, coalesce($10, false))`,
      [
        input.gameId,
        input.userId ?? null,
        input.sessionId ?? null,
        input.device ?? 'unknown',
        input.country ?? null,
        input.referrer ?? null,
        input.utmSource ?? null,
        input.at ?? null,
        input.durationMs ?? null,
        input.completed ?? null,
      ],
    );

    // One statement per counter, `x = x + 1` — concurrent plays cannot lose one.
    await this.conn.run(
      `UPDATE games SET plays = plays + 1, unique_plays = unique_plays + $2 WHERE id = $1`,
      [input.gameId, firstPlayOfSession ? 1 : 0],
    );
    if (input.userId) {
      await this.conn.run(`UPDATE users SET plays_count = plays_count + 1 WHERE id = $1`, [input.userId]);
    }
    return { firstPlayOfSession };
  }

  async playHistory(input: { userId?: ID | null; sessionId?: string | null; gameId?: ID | null; page?: { page: number; perPage: number; offset: number } }): Promise<List<GamePlayRow>> {
    const p = pageOf(input.page);
    const scope = input.userId ? `gp.user_id = $1` : `gp.session_id = $1`;
    const value = input.userId ?? input.sessionId ?? '';
    if (!value) return { items: [], total: 0 };
    // $4 keeps the same position whether or not a game filter is given, so the
    // statement has one shape and one plan — no dynamic renumbering per request.
    // Each statement binds ONLY the parameters it references: PostgreSQL cannot
    // infer the type of a parameter that appears in the list but not in the SQL
    // ("could not determine data type of parameter $2"), so the count query uses
    // $2 for the game filter while the paged query uses $4.
    const total =
      (await this.conn.value<number>(
        `SELECT count(*)::int FROM game_plays gp WHERE ${scope} AND ($2::text IS NULL OR gp.game_id = $2::text)`,
        [value, input.gameId ?? null],
      )) ?? 0;
    const gameScope = `($4::text IS NULL OR gp.game_id = $4::text)`;
    const items = await this.conn.many<GamePlayRow>(
      `SELECT gp.*, jsonb_build_object('id', g.id, 'slug', g.slug, 'title', g.title, 'thumbnailUrl', g.thumbnail_url) AS game
         FROM game_plays gp JOIN games g ON g.id = gp.game_id
        WHERE ${scope} AND ${gameScope}
        ORDER BY gp.started_at DESC LIMIT $2 OFFSET $3`,
      [value, p.perPage, p.offset, input.gameId ?? null],
    );
    return { items: items.map((i) => ({ ...i, game: i.game as unknown as GamePlayRow['game'] })), total };
  }

  /** Distinct recent games for the "continue playing" rail. */
  async continuePlaying(input: { userId?: ID | null; sessionId?: string | null; limit?: number }): Promise<GameRow[]> {
    const value = input.userId ?? input.sessionId;
    if (!value) return [];
    const scope = input.userId ? `gp.user_id = $1` : `gp.session_id = $1`;
    return this.conn.many<GameRow>(
      `SELECT g.* FROM games g
         JOIN (SELECT DISTINCT ON (game_id) game_id, started_at FROM game_plays gp WHERE ${scope} ORDER BY game_id, started_at DESC) recent
           ON recent.game_id = g.id
        WHERE g.status = 'published' AND g.deleted_at IS NULL
        ORDER BY recent.started_at DESC LIMIT $2`,
      [value, input.limit ?? 12],
    );
  }

  async rollupDailyStats(day = new Date()): Promise<{ upserted: number }> {
    const from = new Date(Math.floor(day.getTime() / DAY_MS) * DAY_MS);
    const to = new Date(from.getTime() + DAY_MS);
    let upserted = 0;

    // site-wide
    upserted += await this.conn.run(
      `INSERT INTO daily_stats (day, dimension, key, views, plays, unique_visitors, avg_duration_ms)
       SELECT $1::date, 'site', '', count(*)::int, count(*)::int,
              count(DISTINCT coalesce(session_id, user_id, 'anon'))::int,
              nullif(round(avg(duration_ms))::int, 0)
         FROM game_plays WHERE started_at >= $2 AND started_at < $3
       ON CONFLICT (day, dimension, key) DO UPDATE
         SET views = EXCLUDED.views, plays = EXCLUDED.plays,
             unique_visitors = EXCLUDED.unique_visitors, avg_duration_ms = EXCLUDED.avg_duration_ms`,
      [from, from, to],
    );

    // per game
    upserted += await this.conn.run(
      `INSERT INTO daily_stats (day, dimension, key, game_id, views, plays, unique_visitors, avg_duration_ms)
       SELECT $1::date, 'game', gp.game_id, gp.game_id, count(*)::int, count(*)::int,
              count(DISTINCT coalesce(gp.session_id, gp.user_id, 'anon'))::int,
              nullif(round(avg(gp.duration_ms))::int, 0)
         FROM game_plays gp WHERE gp.started_at >= $2 AND gp.started_at < $3
        GROUP BY gp.game_id
       ON CONFLICT (day, dimension, key) DO UPDATE
         SET views = EXCLUDED.views, plays = EXCLUDED.plays,
             unique_visitors = EXCLUDED.unique_visitors, avg_duration_ms = EXCLUDED.avg_duration_ms`,
      [from, from, to],
    );

    // traffic source
    upserted += await this.conn.run(
      `INSERT INTO daily_stats (day, dimension, key, views, plays, unique_visitors)
       SELECT $1::date, 'source',
              CASE WHEN referrer IS NULL OR referrer = '' THEN 'direct'
                   WHEN utm_source IS NOT NULL AND utm_source <> '' THEN utm_source
                   ELSE coalesce(nullif(split_part(split_part(referrer, '/', 3), 'www.', 1), ''), 'direct') END AS src,
              count(*)::int, count(*)::int, count(DISTINCT coalesce(session_id, user_id, 'anon'))::int
         FROM game_plays WHERE started_at >= $2 AND started_at < $3
        GROUP BY src
       ON CONFLICT (day, dimension, key) DO UPDATE
         SET views = EXCLUDED.views, plays = EXCLUDED.plays, unique_visitors = EXCLUDED.unique_visitors`,
      [from, from, to],
    );

    // device mix
    upserted += await this.rollupDimension('device', `coalesce(device, 'unknown')`, from, to);
    // country mix — ad targeting and the traffic report both group by it
    upserted += await this.rollupDimension('country', `coalesce(nullif(upper(country), ''), 'unknown')`, from, to);

    return { upserted };
  }

  /**
   * One dimension of the daily rollup: views/plays/uniques grouped by `keyExpr`.
   * Kept as a helper because site, source, device and country are the same
   * statement with a different grouping expression — and `keyExpr` is a literal
   * written here, never user input.
   */
  private async rollupDimension(dimension: 'device' | 'country', keyExpr: string, from: Date, to: Date): Promise<number> {
    return this.conn.run(
      `INSERT INTO daily_stats (day, dimension, key, views, plays, unique_visitors)
       SELECT $1::date, $4, ${keyExpr}, count(*)::int, count(*)::int,
              count(DISTINCT coalesce(session_id, user_id, 'anon'))::int
         FROM game_plays WHERE started_at >= $2 AND started_at < $3
        GROUP BY ${keyExpr}
       ON CONFLICT (day, dimension, key) DO UPDATE
         SET views = EXCLUDED.views, plays = EXCLUDED.plays, unique_visitors = EXCLUDED.unique_visitors`,
      [from, from, to, dimension],
    );
  }

  async dashboard(range?: StatsRange): Promise<DashboardStats> {
    const to = range?.to ?? new Date();
    const from = range?.from ?? new Date(to.getTime() - 29 * DAY_MS);

    const [totals, timeline, topGames, sources, devices, countries, categories, pendingComments, openReports, revenue, subs] =
      await Promise.all([
        this.conn.one<{ games: number; publishedGames: number; users: number; plays: number; comments: number }>(
          `SELECT (SELECT count(*)::int FROM games WHERE deleted_at IS NULL) AS "games",
                  (SELECT count(*)::int FROM games WHERE status = 'published' AND deleted_at IS NULL) AS "publishedGames",
                  (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS "users",
                  (SELECT coalesce(sum(plays), 0)::int FROM games) AS "plays",
                  (SELECT count(*)::int FROM comments WHERE deleted_at IS NULL) AS "comments"`,
        ),
        this.conn.many<{ day: string; views: number; plays: number; uniqueVisitors: number }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(views)::int AS "views", sum(plays)::int AS plays,
                  sum(unique_visitors)::int AS "uniqueVisitors"
             FROM daily_stats WHERE dimension = 'site' AND day >= $1::date AND day <= $2::date
            GROUP BY day ORDER BY day`,
          [from, to],
        ),
        this.conn.many<{ id: ID; slug: string; title: string; thumbnailUrl: string; plays: number; ratingAvg: number }>(
          `SELECT id, slug, title, thumbnail_url AS "thumbnailUrl", plays, rating_avg AS "ratingAvg"
             FROM games WHERE status = 'published' AND deleted_at IS NULL
            ORDER BY plays DESC LIMIT 10`,
        ),
        this.conn.many<{ source: string; plays: number }>(
          `SELECT key AS source, sum(plays)::int AS plays FROM daily_stats
            WHERE dimension = 'source' AND day >= $1::date AND day <= $2::date
            GROUP BY key ORDER BY plays DESC LIMIT 10`,
          [from, to],
        ),
        this.conn.many<{ device: string; plays: number }>(
          `SELECT key AS device, sum(plays)::int AS plays FROM daily_stats
            WHERE dimension = 'device' AND day >= $1::date AND day <= $2::date
            GROUP BY key ORDER BY plays DESC`,
          [from, to],
        ),
        this.conn.many<{ country: string; plays: number }>(
          `SELECT key AS country, sum(plays)::int AS plays FROM daily_stats
            WHERE dimension = 'country' AND day >= $1::date AND day <= $2::date
            GROUP BY key ORDER BY plays DESC LIMIT 15`,
          [from, to],
        ),
        this.conn.many<{ slug: string; name: string; gamesCount: number }>(
          `SELECT slug, name, games_count AS "gamesCount" FROM categories
            WHERE deleted_at IS NULL ORDER BY games_count DESC LIMIT 10`,
        ),
        this.conn.value<number>(`SELECT count(*)::int FROM comments WHERE status = 'pending' AND deleted_at IS NULL`),
        this.conn.value<number>(`SELECT count(*)::int FROM reports WHERE status = 'open'`),
        this.conn.value<number>(`SELECT coalesce(sum(amount_cents), 0)::int FROM payments WHERE status = 'succeeded'`),
        this.conn.value<number>(`SELECT count(*)::int FROM subscriptions WHERE status = 'active'`),
      ]);

    return {
      totals: {
        games: totals?.games ?? 0,
        publishedGames: totals?.publishedGames ?? 0,
        users: totals?.users ?? 0,
        plays: totals?.plays ?? 0,
        comments: totals?.comments ?? 0,
        pendingComments: pendingComments ?? 0,
        openReports: openReports ?? 0,
        revenueCents: revenue ?? 0,
        activeSubscriptions: subs ?? 0,
      },
      timeline,
      topGames,
      sources,
      devices,
      countries,
      categories,
    };
  }

  async countPlays(since?: Date): Promise<number> {
    return (
      (await this.conn.value<number>(
        since ? `SELECT count(*)::int FROM game_plays WHERE started_at >= $1` : `SELECT count(*)::int FROM game_plays`,
        since ? [since] : [],
      )) ?? 0
    );
  }

  async gameStats(gameId: ID, range?: StatsRange): Promise<{ day: string; plays: number; uniqueVisitors: number }[]> {
    const to = range?.to ?? new Date();
    const from = range?.from ?? new Date(to.getTime() - 29 * DAY_MS);
    return this.conn.many(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, plays, unique_visitors AS "uniqueVisitors"
         FROM daily_stats WHERE dimension = 'game' AND game_id = $1 AND day >= $2::date AND day <= $3::date
        ORDER BY day`,
      [gameId, from, to],
    );
  }

  // ─────────────────────────── achievements & XP ───────────────────────────

  async upsertAchievement(data: Partial<AchievementRow> & { slug: string; name: string }): Promise<AchievementRow> {
    const row = await this.conn.one<AchievementRow>(
      `INSERT INTO achievements (id, slug, name, description, icon, tier, xp, rule, is_hidden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
             tier = EXCLUDED.tier, xp = EXCLUDED.xp, rule = EXCLUDED.rule, is_hidden = EXCLUDED.is_hidden
       RETURNING *`,
      [
        newId(),
        data.slug,
        data.name,
        data.description ?? null,
        data.icon ?? null,
        data.tier ?? 'bronze',
        data.xp ?? 10,
        JSON.stringify(data.rule ?? {}),
        data.isHidden ?? false,
      ],
    );
    if (!row) throw new Error('upsertAchievement: no row returned');
    return row;
  }

  async listAchievements(): Promise<AchievementRow[]> {
    return this.conn.many<AchievementRow>(`SELECT * FROM achievements ORDER BY xp ASC, slug`);
  }

  async countUserActions(userId: ID): Promise<UserActionCounts> {
    // One round trip for five counters. Evaluating achievements per-event would
    // otherwise cost five queries on every single play — the hottest path we have.
    const row = await this.conn.one<UserActionCounts>(
      `SELECT (SELECT count(*)::int FROM game_plays  WHERE user_id = $1) AS plays,
              (SELECT count(*)::int FROM ratings     WHERE user_id = $1) AS ratings,
              (SELECT count(*)::int FROM comments    WHERE user_id = $1 AND deleted_at IS NULL) AS comments,
              (SELECT count(*)::int FROM favorites   WHERE user_id = $1) AS favorites,
              (SELECT count(*)::int FROM playlists   WHERE user_id = $1) AS playlists`,
      [userId],
    );
    return row ?? { plays: 0, ratings: 0, comments: 0, favorites: 0, playlists: 0 };
  }

  async achievementsForUser(userId: ID): Promise<AchievementRow[]> {
    return this.conn.many<AchievementRow>(
      `SELECT a.*, ua.progress, ua.unlocked_at AS "unlockedAt"
         FROM achievements a LEFT JOIN user_achievements ua ON ua.achievement_id = a.id AND ua.user_id = $1
        ORDER BY (ua.unlocked_at IS NULL), a.xp ASC`,
      [userId],
    );
  }

  async unlockAchievement(userId: ID, achievementId: ID): Promise<boolean> {
    const affected = await this.conn.run(
      `INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at)
       VALUES ($1,$2,100,now()) ON CONFLICT DO NOTHING`,
      [userId, achievementId],
    );
    if (affected === 0) return false;
    const badge = await this.conn.one<{ xp: number; name: string }>(`SELECT xp, name FROM achievements WHERE id = $1`, [achievementId]);
    if (badge) {
      await this.awardXp({ userId, amount: badge.xp, reason: `achievement:${badge.name}`, targetKind: 'user', targetId: userId });
    }
    return true;
  }

  async awardXp(input: { userId: ID; amount: number; reason: string; targetKind?: string | null; targetId?: ID | null }): Promise<{
    xp: number;
    level: number;
    leveledUp: boolean;
  }> {
    const before = await this.conn.one<{ xp: number; level: number }>(`SELECT xp, level FROM users WHERE id = $1`, [input.userId]);
    if (!before) return { xp: 0, level: 1, leveledUp: false };
    const xp = Math.max(0, before.xp + input.amount);
    const level = XP.levelFor(xp);
    await this.conn.run(
      `INSERT INTO xp_events (user_id, amount, reason, target_kind, target_id, created_at) VALUES ($1,$2,$3,$4,$5,now())`,
      [input.userId, input.amount, input.reason, input.targetKind ?? null, input.targetId ?? null],
    );
    await this.conn.run(`UPDATE users SET xp = $2, level = $3, updated_at = now() WHERE id = $1`, [input.userId, xp, level]);
    return { xp, level, leveledUp: level > before.level };
  }

  // ───────────────────────────── notifications ─────────────────────────────

  async notify(input: {
    userId: ID;
    kind: string;
    title: string;
    body?: string | null;
    link?: string | null;
    data?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.conn.run(
      `INSERT INTO notifications (user_id, kind, title, body, link, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [input.userId, input.kind, input.title, input.body ?? null, input.link ?? null, input.data ? JSON.stringify(input.data) : null],
    );
  }

  async listNotifications(userId: ID, page?: { page: number; perPage: number; offset: number }): Promise<List<NotificationRow>> {
    const p = pageOf(page, 20);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM notifications WHERE user_id = $1`, [userId])) ?? 0;
    const items = await this.conn.many<NotificationRow>(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, p.perPage, p.offset],
    );
    return { items, total };
  }

  async markNotificationRead(id: number, userId: ID): Promise<boolean> {
    return (await this.conn.run(`UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`, [id, userId])) > 0;
  }

  async markAllNotificationsRead(userId: ID): Promise<number> {
    return this.conn.run(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  }

  async unreadNotificationCount(userId: ID): Promise<number> {
    return (await this.conn.value<number>(`SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId])) ?? 0;
  }
}
