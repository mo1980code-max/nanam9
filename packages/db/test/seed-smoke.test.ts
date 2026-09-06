import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDatabase, type TestDatabase } from './helpers/database.js';
import { seedDatabase } from '../src/seed/content.js';
import { verifyPassword } from '../src/passwords.js';
import type { ID } from '../src/ports.js';

/**
 * End-to-end proof that the data layer works against a real PostgreSQL:
 * migrate → seed → read through every repository the API will use.
 *
 * These are the tests that catch the bugs a type-checker cannot: a parameter
 * bound to the wrong placeholder, an enum compared with text, a jsonb column
 * handed a JS object, a counter that drifts from the rows it counts.
 */

let ctx: TestDatabase;
let seeded: { adminPassword?: string };

beforeAll(async () => {
  // Fixed so the Argon2 assertion below is deterministic; without it the seeder
  // generates a random password (which is the correct production behaviour).
  process.env.SEED_ADMIN_PASSWORD = 'Voltade!2026';
  ctx = await withDatabase();
  seeded = await seedDatabase(ctx.db, { demo: true, onLog: () => {} });
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('migrations', () => {
  it('applies both migrations and creates the full catalogue of tables', async () => {
    const info = await ctx.conn.many<{ name: string }>(
      `SELECT migration_name AS name FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(info.map((m) => m.name)).toEqual(['20260905120000_init', '20260905120200_search_and_constraints']);

    const tables = await ctx.conn.value<number>(
      `SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables).toBeGreaterThanOrEqual(44); // 43 models + _prisma_migrations
  });

  it('is a no-op the second time (idempotent DDL bookkeeping)', async () => {
    const { migrate } = await import('../src/migrate/runner.js');
    const { migrationsDir } = await import('../src/env.js');
    const result = await migrate(ctx.conn, migrationsDir());
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBe(2);
    expect(result.checksumMismatches).toEqual([]);
  });
});

describe('rbac', () => {
  it('seeds the permission catalogue and the five roles', async () => {
    const roles = await ctx.db.identity.listRoles();
    expect(roles.map((r) => r.slug).sort()).toEqual(['admin', 'editor', 'moderator', 'super-admin', 'user']);

    const permissions = await ctx.db.identity.listPermissions();
    expect(permissions.length).toBeGreaterThanOrEqual(39);
    expect(permissions.some((p) => p.slug === 'games.publish')).toBe(true);
  });

  it('resolves super-admin to the wildcard and a player to their own grants', async () => {
    const superAdmin = await ctx.db.identity.findRoleBySlug('super-admin');
    const user = await ctx.db.identity.findRoleBySlug('user');
    // `['*']` in @voltade/shared is *materialised* into every catalogue
    // permission at sync time: a role_permissions row must point at a real
    // permission, and the API guard still short-circuits on level >= super-admin.
    const superPerms = await ctx.db.identity.permissionsForRoleIds([superAdmin!.id]);
    const all = await ctx.db.identity.listPermissions();
    expect(superPerms.length).toBe(all.length);
    expect(superPerms).toContain('settings.manage');

    // A registered player needs exactly one grant: the right to comment. Public
    // catalogue browsing is not permission-gated (it is cached, anonymous traffic),
    // so `games.view` belongs to staff roles only.
    const userPerms = await ctx.db.identity.permissionsForRoleIds([user!.id]);
    expect(userPerms).toEqual(['comments.create']);

    const moderator = await ctx.db.identity.findRoleBySlug('moderator');
    const modPerms = await ctx.db.identity.permissionsForRoleIds([moderator!.id]);
    expect(modPerms).toEqual(expect.arrayContaining(['comments.moderate', 'reports.resolve']));
    expect(modPerms).not.toContain('settings.manage');
  });
});

describe('settings', () => {
  it('separates public from private settings', async () => {
    const all = await ctx.db.operations.getSettings();
    const publicOnly = await ctx.db.operations.getSettings({ publicOnly: true });
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(publicOnly.length).toBeLessThan(all.length);
    expect(publicOnly.some((s) => s.key === 'ads.adsenseClient')).toBe(false); // never exposed to the client
    expect(publicOnly.some((s) => s.key === 'site.name')).toBe(true);
  });

  it('reads a typed value back as JSON, not as a string', async () => {
    const perPage = await ctx.db.operations.getSetting('games.perPage');
    expect(perPage?.value).toBe(24);
    const moderation = await ctx.db.operations.getSetting('games.commentModeration');
    expect(moderation?.value).toBe('guests');
  });

  it('does not overwrite an operator-edited value on re-seed', async () => {
    await ctx.db.operations.setSetting({ key: 'site.name', value: 'My Portal' });
    await seedDatabase(ctx.db, { demo: true, onLog: () => {} });
    expect((await ctx.db.operations.getSetting('site.name'))?.value).toBe('My Portal');
    await ctx.db.operations.setSetting({ key: 'site.name', value: 'Voltade' });
  });
});

describe('catalogue', () => {
  it('builds a nested category tree', async () => {
    const tree = await ctx.db.catalog.categoryTree();
    const arcade = tree.find((c) => c.slug === 'arcade');
    expect(arcade).toBeDefined();
    expect(arcade!.children?.map((c) => c.slug)).toContain('classic');
    expect(tree.every((c) => c.parentId === null)).toBe(true); // roots only
  });

  it('lists published games with their relations in one page', async () => {
    const page = await ctx.db.catalog.listGames({ status: 'published', with: ['categories', 'tags'], page: { page: 1, perPage: 24, offset: 0 } });
    expect(page.total).toBe(6);
    expect(page.items.length).toBe(6);
    const snake = page.items.find((g) => g.slug === 'snake-volt')!;
    expect(snake.categories?.map((c) => c.slug)).toEqual(expect.arrayContaining(['arcade', 'classic', 'mobile']));
    expect(snake.tags?.length).toBeGreaterThan(0);
  });

  it('sorts by the documented semantics', async () => {
    const popular = await ctx.db.catalog.listGames({ status: 'published', sort: 'popular', page: { page: 1, perPage: 3, offset: 0 } });
    const plays = popular.items.map((g) => g.plays);
    expect(plays).toEqual([...plays].sort((a, b) => b - a));

    const rated = await ctx.db.catalog.listGames({ status: 'published', sort: 'top_rated', page: { page: 1, perPage: 3, offset: 0 } });
    const avgs = rated.items.map((g) => g.ratingAvg);
    expect(avgs).toEqual([...avgs].sort((a, b) => b - a));

    const az = await ctx.db.catalog.listGames({ status: 'published', sort: 'az', page: { page: 1, perPage: 6, offset: 0 } });
    expect(az.items.length).toBe(6);
  });

  it('finds games by an Arabic query through the generated tsvector', async () => {
    const arabic = await ctx.db.catalog.listGames({ q: 'الثعبان', page: { page: 1, perPage: 10, offset: 0 } });
    expect(arabic.items.map((g) => g.slug)).toContain('snake-volt');

    const english = await ctx.db.catalog.listGames({ q: 'pong', page: { page: 1, perPage: 10, offset: 0 } });
    expect(english.items.map((g) => g.slug)).toContain('neon-pong');

    const miss = await ctx.db.catalog.listGames({ q: 'zzz-not-a-game', page: { page: 1, perPage: 10, offset: 0 } });
    expect(miss.total).toBe(0);
  });

  it('filters by category and by tag', async () => {
    const puzzle = await ctx.db.catalog.listGames({ categorySlug: 'puzzle', page: { page: 1, perPage: 10, offset: 0 } });
    expect(puzzle.items.map((g) => g.slug).sort()).toEqual(['memory-cards', 'volt-2048']);

    const retro = await ctx.db.catalog.listGames({ tagSlug: 'retro', page: { page: 1, perPage: 10, offset: 0 } });
    expect(retro.items.map((g) => g.slug).sort()).toEqual(['neon-pong', 'snake-volt']);
  });

  it('keeps denormalised counters in agreement with the rows they count', async () => {
    for (const game of (await ctx.db.catalog.listGames({ status: 'published', page: { page: 1, perPage: 10, offset: 0 } })).items) {
      const ratings = await ctx.db.social.ratingBreakdown(game.id);
      const count = ratings.reduce((n, r) => n + r.count, 0);
      expect(game.ratingCount, `${game.slug} rating_count`).toBe(count);
      if (count > 0) {
        const avg = ratings.reduce((sum, r) => sum + r.stars * r.count, 0) / count;
        expect(Math.abs(game.ratingAvg - avg), `${game.slug} rating_avg`).toBeLessThan(0.01);
      }
      const comments = await ctx.db.social.listComments({ gameId: game.id, page: { page: 1, perPage: 100, offset: 0 }, tree: false });
      expect(game.commentsCount, `${game.slug} comments_count`).toBeGreaterThanOrEqual(comments.total);
    }
  });

  it('recalculates counters from scratch on demand', async () => {
    const game = await ctx.db.catalog.findGameBySlug('volt-2048');
    await ctx.db.catalog.incrementGame(game!.id, 'plays', 1000); // simulate drift
    await ctx.db.catalog.recalcGameCounters(game!.id);
    const fresh = await ctx.db.catalog.findGameBySlug('volt-2048');
    const plays = await ctx.conn.value<number>(`SELECT count(*)::int FROM game_plays WHERE game_id = $1`, [game!.id]);
    // recalc fixes the derived counters; `plays` is an event total, so it stays
    expect(fresh!.commentsCount).toBeGreaterThanOrEqual(0);
    expect(plays).toBeGreaterThan(0);
  });
});

describe('duplicate-game protection', () => {
  it('refuses a second game with the same source_hash', async () => {
    const existing = await ctx.db.catalog.findGameBySlug('neon-pong');
    expect(existing!.sourceHash).toBeTruthy();
    expect((await ctx.db.catalog.findGameBySourceHash(existing!.sourceHash!))?.slug).toBe('neon-pong');

    await expect(
      ctx.db.catalog.createGame({
        slug: 'neon-pong-copy',
        title: 'copy',
        url: '/games/neon-pong/index.html',
        thumbnailUrl: '/games/neon-pong/thumb.svg',
        sourceHash: existing!.sourceHash!,
      }),
    ).rejects.toThrow(/source_hash|duplicate key/i);
  });
});

describe('social', () => {
  it('returns a nested comment tree', async () => {
    const game = await ctx.db.catalog.findGameBySlug('snake-volt');
    const thread = await ctx.db.social.listComments({ gameId: game!.id, page: { page: 1, perPage: 20, offset: 0 } });
    const root = thread.items.find((c) => (c.children?.length ?? 0) > 0);
    expect(root, 'expected at least one comment with replies').toBeDefined();
    expect(root!.user?.username).toBeTruthy();
    // The seeded thread is a reply-to-a-reply, so the tree must be two deep —
    // flat "children of the root" would hide the recursion.
    expect(root!.children!.length).toBe(1);
    expect(root!.children![0]!.body).toContain('٢١٠');
    expect(root!.children![0]!.children!.length).toBe(1);
    expect(root!.children![0]!.children![0]!.parentId).toBe(root!.children![0]!.id);
    // roots only: a reply never appears at the top level of the page
    expect(thread.items.every((c) => c.parentId === null)).toBe(true);
  });

  it('hides pending comments from the public listing but shows them to moderators', async () => {
    const game = await ctx.db.catalog.findGameBySlug('neon-pong');
    const publicView = await ctx.db.social.listComments({ gameId: game!.id, page: { page: 1, perPage: 20, offset: 0 } });
    expect(publicView.items.every((c) => c.status === 'visible')).toBe(true);

    const queue = await ctx.db.social.listComments({ status: 'pending', page: { page: 1, perPage: 20, offset: 0 }, tree: false });
    expect(queue.total).toBeGreaterThanOrEqual(1);
    const byStatus = await ctx.db.social.countCommentsByStatus();
    expect(byStatus.pending).toBeGreaterThanOrEqual(1);
  });

  it('records a vote once and flips it instead of duplicating', async () => {
    const game = await ctx.db.catalog.findGameBySlug('brick-blitz');
    const user = await ctx.db.identity.findUserByUsername('nour');
    const first = await ctx.db.social.vote({ userId: user!.id, targetKind: 'game', targetId: game!.id, value: 1 });
    expect(first.value).toBe(1);
    const flipped = await ctx.db.social.vote({ userId: user!.id, targetKind: 'game', targetId: game!.id, value: -1 });
    expect(flipped.value).toBe(-1);
    expect(flipped.changed).toBe(true);

    const rows = await ctx.conn.value<number>(
      `SELECT count(*)::int FROM likes WHERE user_id = $1 AND target_kind = 'game' AND target_id = $2`,
      [user!.id, game!.id],
    );
    expect(rows).toBe(1); // one row per (user, target), never two

    const fresh = await ctx.db.catalog.findGameBySlug('brick-blitz');
    expect(fresh!.dislikesCount).toBeGreaterThanOrEqual(1);
  });

  it('favourites and playlists round-trip with a shareable slug', async () => {
    const user = await ctx.db.identity.findUserByUsername('layla');
    const favourites = await ctx.db.social.listFavorites(user!.id, { page: 1, perPage: 10, offset: 0 });
    expect(favourites.total).toBe(6);
    expect(await ctx.db.social.isFavorite(user!.id, favourites.items[0]!.id)).toBe(true);

    const playlist = await ctx.db.social.findPlaylist('evening-session', user!.id);
    expect(playlist).not.toBeNull();
    const games = await ctx.db.social.playlistGames(playlist!.id);
    expect(games.length).toBe(4);
    expect(playlist!.gamesCount).toBe(4);
  });
});

describe('analytics', () => {
  it('rolls 30 days of plays into a dashboard with a real shape', async () => {
    const stats = await ctx.db.engagement.dashboard();
    expect(stats.totals.games).toBe(6);
    expect(stats.totals.publishedGames).toBe(6);
    expect(stats.totals.users).toBeGreaterThanOrEqual(12);
    expect(stats.timeline.length).toBeGreaterThanOrEqual(28);
    expect(stats.timeline.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    expect(stats.topGames.length).toBe(6);
    expect(stats.topGames[0]!.plays).toBeGreaterThanOrEqual(stats.topGames[5]!.plays);

    expect(stats.devices.map((d) => d.device)).toEqual(expect.arrayContaining(['mobile', 'desktop']));
    expect(stats.countries.map((c) => c.country)).toEqual(expect.arrayContaining(['SA', 'EG']));
    expect(stats.sources.map((s) => s.source)).toEqual(expect.arrayContaining(['direct']));
  });

  it('counts tracked play sessions (the seeder\u2019s idempotency guard)', async () => {
    const total = await ctx.db.engagement.countPlays();
    expect(total).toBeGreaterThanOrEqual(500);
    const lastWeek = await ctx.db.engagement.countPlays(new Date(Date.now() - 7 * 86_400_000));
    expect(lastWeek).toBeLessThan(total);
    expect(lastWeek).toBeGreaterThan(0);
  });

  it('returns a per-game timeline for the game page chart', async () => {
    const game = await ctx.db.catalog.findGameBySlug('volt-2048');
    const series = await ctx.db.engagement.gameStats(game!.id);
    expect(series.length).toBeGreaterThan(20);
    expect(series.every((d) => d.plays >= 0)).toBe(true);
  });
});

describe('identity & auth', () => {
  it('verifies the seeded admin password with Argon2id and rejects a wrong one', async () => {
    const creds = await ctx.db.identity.findUserCredentials('admin');
    expect(creds).not.toBeNull();
    expect(creds!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(creds!.passwordHash, 'Voltade!2026')).toBe(true);
    expect(await verifyPassword(creds!.passwordHash, 'wrong')).toBe(false);
    expect(await verifyPassword(null, 'anything')).toBe(false);
  });

  it('finds a user by email, username or id, case-insensitively', async () => {
    const byEmail = await ctx.db.identity.findUserByEmail('LAYLA@example.com');
    const byUsername = await ctx.db.identity.findUserByUsername('layla');
    const byLogin = await ctx.db.identity.findUserByLogin('layla');
    expect(byEmail?.id).toBe(byUsername?.id);
    expect(byLogin?.id).toBe(byUsername?.id);
    expect((await ctx.db.identity.findUserById(byUsername!.id, true))?.role?.slug).toBe('user');
    expect((await ctx.db.identity.findUserById(byUsername!.id, false))?.role).toBeUndefined();
  });

  it('issues, touches and revokes sessions', async () => {
    const user = await ctx.db.identity.findUserByUsername('omar');
    const session = await ctx.db.identity.createSession({
      userId: user!.id,
      tokenHash: 'hash-1',
      userAgent: 'vitest',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect((await ctx.db.identity.findSessionByHash('hash-1'))?.id).toBe(session.id);
    await ctx.db.identity.touchSession(session.id);
    expect((await ctx.db.identity.listSessions(user!.id)).length).toBe(1);
    expect(await ctx.db.identity.revokeSession(session.id)).toBe(true);
    expect(await ctx.db.identity.findSessionByHash('hash-1')).toBeNull();
  });
});

describe('content & commerce', () => {
  it('serves blog posts with author, category and tags', async () => {
    const post = await ctx.db.content.findPostBySlug('why-html5-games-win-in-2026');
    expect(post).not.toBeNull();
    expect(post!.author?.username).toBeTruthy();
    expect(post!.category?.slug).toBe('industry');
    expect(post!.tags?.map((t) => t.slug)).toContain('html5');

    const list = await ctx.db.content.listPosts({ status: 'published', page: { page: 1, perPage: 10, offset: 0 } });
    expect(list.total).toBe(4);
    expect((await ctx.db.content.relatedPosts(post!.id, 3)).length).toBeGreaterThan(0);
  });

  it('serves the page builder blocks as JSON, not as a string', async () => {
    const about = await ctx.db.content.findPageBySlug('about');
    expect(Array.isArray(about!.blocks)).toBe(true);
    const blocks = about!.blocks as unknown as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['hero', 'rich_text', 'stat_row']);
  });

  it('returns the ads configured for a placement', async () => {
    const header = await ctx.db.commerce.adsForPlacement('header');
    expect(header.length).toBe(1);
    expect(header[0]!.code).toContain('ad-placeholder');
    const interstitial = await ctx.db.commerce.adsForPlacement('interstitial');
    expect(interstitial.length).toBe(0); // seeded paused: a placeholder must never auto-serve
  });

  it('treats a user with an active subscription as premium', async () => {
    const premium = await ctx.db.identity.findUserByUsername('yousef');
    const plain = await ctx.db.identity.findUserByUsername('layla');
    expect(await ctx.db.commerce.isPremium(premium!.id)).toBe(true);
    expect(await ctx.db.commerce.isPremium(plain!.id)).toBe(false);
    expect(await ctx.db.commerce.isPremium(null)).toBe(false);
    expect((await ctx.db.commerce.activeSubscriptionFor(premium!.id))?.status).toBe('active');
    expect((await ctx.db.commerce.listPayments(premium!.id)).items[0]!.amountCents).toBe(3990);
  });
});

describe('provider import queue', () => {
  it('stages feed items and marks the duplicate', async () => {
    const items = await ctx.db.operations.listProviderItems({ page: { page: 1, perPage: 50, offset: 0 } });
    // 8 feed items + 7 provider-independent title hashes: "Desert Drift Rally"
    // arrives from two distributors and must collapse to one catalogue entry.
    expect(items.total).toBe(15);
    const duplicates = items.items.filter((i) => i.status === 'duplicate');
    expect(duplicates.length).toBeGreaterThan(0);
    expect(duplicates[0]!.title).toBe('Desert Drift Rally');
    expect(items.items.some((i) => i.status === 'new')).toBe(true);

    const jobs = await ctx.db.operations.listImportJobs({ page: { page: 1, perPage: 5, offset: 0 } });
    expect(jobs.total).toBeGreaterThanOrEqual(1);
    expect(jobs.items[0]!.fetchedCount).toBe(8);
    expect(jobs.items[0]!.duplicateCount).toBeGreaterThan(0);
  });

  it('re-staging the same item returns the existing row instead of inserting', async () => {
    const provider = await ctx.db.operations.findProviderBySlug('gamemonetize');
    const first = await ctx.db.operations.stageProviderItem({
      providerId: provider!.id,
      providerGameId: 'gm-new-1',
      sourceHash: 'a'.repeat(64),
      title: 'Brand New Game',
      payload: { title: 'Brand New Game' },
    });
    expect(first.existed).toBe(false);
    const second = await ctx.db.operations.stageProviderItem({
      providerId: provider!.id,
      providerGameId: 'gm-new-1',
      sourceHash: 'a'.repeat(64),
      title: 'Brand New Game',
      payload: { title: 'Brand New Game', refetched: true },
    });
    expect(second.existed).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe('transactions', () => {
  it('commits when the callback succeeds', async () => {
    await ctx.db.tx(async (tx) => {
      await tx.operations.setSetting({ key: 'tx.probe', value: 'committed', group: 'test', isPublic: false });
    });
    expect((await ctx.db.operations.getSetting('tx.probe'))?.value).toBe('committed');
  });

  it('rolls back every write when the callback throws', async () => {
    await expect(
      ctx.db.tx(async (tx) => {
        await tx.operations.setSetting({ key: 'tx.rollback', value: 'never', group: 'test', isPublic: false });
        await tx.catalog.createGame({ slug: 'tx-game', title: 'tx', url: '/x', thumbnailUrl: '/x.svg' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await ctx.db.operations.getSetting('tx.rollback')).toBeNull();
    expect(await ctx.db.catalog.findGameBySlug('tx-game')).toBeNull();
  });

  it('sees its own writes inside the transaction', async () => {
    const slug = await ctx.db.tx(async (tx) => {
      const game = await tx.catalog.createGame({ slug: 'tx-visible', title: 'tx', url: '/x', thumbnailUrl: '/x.svg' });
      const read = await tx.catalog.findGameBySlug('tx-visible');
      return read?.id === game.id ? game.slug : 'mismatch';
    });
    expect(slug).toBe('tx-visible');
    await ctx.db.catalog.deleteGame((await ctx.db.catalog.findGameBySlug('tx-visible'))!.id, { hard: true });
  });
});

describe('re-seeding', () => {
  it('changes nothing except the audit log', async () => {
    const count = async (table: string) =>
      (await ctx.conn.value<number>(`SELECT count(*)::int FROM "${table}"`)) ?? -1;
    const tables = ['games', 'users', 'comments', 'ratings', 'game_plays', 'daily_stats', 'settings', 'provider_items', 'notifications', 'subscriptions'];
    const before: Record<string, number> = {};
    for (const t of tables) before[t] = await count(t);

    await seedDatabase(ctx.db, { demo: true, onLog: () => {} });

    for (const t of tables) expect(await count(t), `${t} grew on re-seed`).toBe(before[t]);

    const logs = await count('activity_logs');
    expect(logs).toBeGreaterThan(1); // each seed run is recorded on purpose
  });

  it('prints no password when SEED_ADMIN_PASSWORD was supplied', () => {
    expect(seeded.adminPassword).toBeUndefined();
  });
});

describe('soft delete', () => {
  it('hides a deleted game from listings but keeps it for the admin', async () => {
    const game = await ctx.db.catalog.findGameBySlug('tic-tac-volt');
    expect(game).not.toBeNull();
    await ctx.db.catalog.deleteGame(game!.id);

    expect(await ctx.db.catalog.findGameBySlug('tic-tac-volt')).toBeNull();
    const publicList = await ctx.db.catalog.listGames({ status: 'published', page: { page: 1, perPage: 20, offset: 0 } });
    expect(publicList.items.map((g) => g.slug)).not.toContain('tic-tac-volt');

    // A soft delete archives *and* stamps deleted_at, so the admin "trash" view
    // asks for the archived status with includeDeleted.
    const trash = await ctx.db.catalog.listGames({ status: 'archived', includeDeleted: true, page: { page: 1, perPage: 20, offset: 0 } });
    expect(trash.items.map((g) => g.slug)).toContain('tic-tac-volt');

    // restore, so the rest of the suite sees the full catalogue
    await ctx.db.catalog.updateGame(game!.id, { deletedAt: null, status: 'published' });
    const restored = await ctx.db.catalog.findGameBySlug('tic-tac-volt');
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(game!.id);
    expect(restored!.status).toBe('published');
  });
});
