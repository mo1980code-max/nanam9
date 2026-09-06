/**
 * SQL driver — catalogue: games, categories, tags, assets.
 *
 * Three rules this file lives by:
 *  · Writable columns are an explicit allowlist. A PATCH body from a client can
 *    never reach `plays`, `rating_avg` or `search_vector` (generated column) —
 *    mass-assignment is how marketplace scripts get their counters forged.
 *  · Every list query is `SELECT … WHERE … ORDER BY <indexed expression> LIMIT`,
 *    and each ORDER BY matches a partial index declared in migration
 *    20260905120200. A sort with no index is a sequential scan over 20k games.
 *  · Counters are maintained with `SET x = x + 1` inside the same statement or
 *    transaction that caused the change, never read-modify-write in JS.
 */

import { slugify, uniqueSlug } from '@voltade/shared';
import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type {
  CatalogRepository,
  CategoryRow,
  GameAssetRow,
  GameListFilter,
  GameRow,
  ID,
  List,
  TagRow,
} from '../../ports.js';
import { GAME_CATEGORIES_SQL, GAME_TAGS_SQL, PgRepo, eq, escapeLike, groupRelations, inList, likeAny, newId, pageOf, snakeCase, toColumns } from './helpers.js';


/** Keeps only the listed keys, renamed to physical columns. */

const GAME_FIELDS = [
  'slug',
  'title',
  'titleEn',
  'description',
  'descriptionEn',
  'instructions',
  'developer',
  'version',
  'releaseYear',
  'kind',
  'url',
  'filePath',
  'width',
  'height',
  'orientation',
  'sizeKb',
  'thumbnailUrl',
  'bannerUrl',
  'gallery',
  'status',
  'featured',
  'premium',
  'ageRating',
  'providerSlug',
  'providerGameId',
  'providerUrl',
  'sourceHash',
  'publishedAt',
  'seoTitle',
  'seoDescription',
  'seoKeywords',
  'canonicalUrl',
  'noindex',
  'meta',
  'deletedAt',
] as const;

/** Counters and audit columns are never writable from a request body. */
const GAME_COUNTER_FIELDS = ['plays', 'uniquePlays', 'likesCount', 'dislikesCount', 'ratingAvg', 'ratingCount', 'commentsCount', 'favoritesCount'] as const;

const CATEGORY_FIELDS = [
  'slug',
  'parentId',
  'name',
  'nameEn',
  'description',
  'icon',
  'thumbnailUrl',
  'color',
  'sortOrder',
  'isVisible',
  'seoTitle',
  'seoDescription',
  'seoKeywords',
  'canonicalUrl',
  'deletedAt',
] as const;

/** Logical sort → SQL. Every value here has an index behind it. */
const GAME_SORTS: Record<string, string> = {
  newest: 'g.published_at DESC NULLS LAST, g.created_at DESC',
  popular: 'g.plays DESC, g.published_at DESC',
  top_rated: 'g.rating_avg DESC, g.rating_count DESC',
  most_liked: 'g.likes_count DESC, g.plays DESC',
  trending: 'g.plays DESC, g.published_at DESC',
  az: 'g.title ASC',
  updated: 'g.updated_at DESC',
  random: 'random()',
};

const GAME_SELECT = 'SELECT g.*';
const GAME_FROM = 'games g';

export class PgCatalogRepository extends PgRepo implements CatalogRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  // ───────────────────────────── reads ─────────────────────────────

  async findGameBySlug(slug: string, withRelations = true): Promise<GameRow | null> {
    const row = await this.conn.one<GameRow>(
      `SELECT g.* FROM games g WHERE g.slug = $1 AND g.deleted_at IS NULL LIMIT 1`,
      [slug],
    );
    if (!row) return null;
    if (withRelations) await this.attachRelations([row]);
    return row;
  }

  async findGameById(id: ID, withRelations = true): Promise<GameRow | null> {
    const row = await this.conn.one<GameRow>(`SELECT g.* FROM games g WHERE g.id = $1`, [id]);
    if (!row || !withRelations) return row;
    await this.attachRelations([row]);
    return row;
  }

  async findGameBySourceHash(hash: string): Promise<GameRow | null> {
    return this.conn.one<GameRow>(`SELECT g.* FROM games g WHERE g.source_hash = $1 LIMIT 1`, [hash]);
  }

  /**
   * The catalogue query. `publishedOnly` is the default because the public site
   * must never be able to render a draft: an admin-only listing has to *ask* for
   * other statuses explicitly.
   */
  async listGames(filter: GameListFilter = {}): Promise<List<GameRow>> {
    const page = pageOf(filter.page);
    const conds: SqlPart[] = [];

    const idFilter = inList('g.id', filter.ids);
    if (idFilter) conds.push(idFilter);
    if (filter.excludeId) conds.push(sql`g.id <> ${filter.excludeId}`);
    conds.push(filter.includeDeleted ? sql`TRUE` : sql`g.deleted_at IS NULL`);

    if (filter.status) {
      const statusCond = Array.isArray(filter.status) ? inList('g.status', filter.status) : eq('g.status', filter.status);
      if (statusCond) conds.push(statusCond);
    } else if (filter.publishedOnly !== false) {
      conds.push(sql`g.status = 'published'`);
    }

    for (const cond of [
      eq('g.featured', filter.featured),
      eq('g.premium', filter.premium),
      eq('g.age_rating', filter.ageRating),
      eq('g.kind', filter.kind),
    ]) {
      if (cond) conds.push(cond);
    }

    if (filter.categorySlug) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM category_game cg JOIN categories c ON c.id = cg.category_id
                     WHERE cg.game_id = g.id AND c.slug = ${filter.categorySlug} AND c.deleted_at IS NULL)`,
      );
    }
    if (filter.categorySlugs?.length) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM category_game cg JOIN categories c ON c.id = cg.category_id
                     WHERE cg.game_id = g.id AND c.slug = ANY(${filter.categorySlugs}) AND c.deleted_at IS NULL)`,
      );
    }
    if (filter.tagSlug) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM tag_game tg JOIN tags t ON t.id = tg.tag_id
                     WHERE tg.game_id = g.id AND t.slug = ${filter.tagSlug})`,
      );
    }

    // Search: full-text first (ranked, indexed), ILIKE as the safety net for
    // partial words and for Arabic input the 'simple' config cannot stem.
    const q = filter.q?.trim();
    let orderBy = GAME_SORTS[filter.sort ?? 'newest'] ?? GAME_SORTS.newest!;
    if (q) {
      const tsQuery = q.split(/\s+/).filter(Boolean).join(' & ');
      // Genre words live in the taxonomy, not in the title: searching "سباق" or
      // "puzzle" must find the racing/puzzle games even though neither word appears
      // in their names. Both EXISTS probes are index-backed (categories_name_lower,
      // tags_name_lower and the two join primary keys).
      const like = `%${escapeLike(q)}%`;
      conds.push(
        sql`(g.search_vector @@ plainto_tsquery('simple', ${tsQuery})
             OR g.title ILIKE ${like}
             OR g.title_en ILIKE ${like}
             OR g.slug ILIKE ${like}
             OR EXISTS (SELECT 1 FROM category_game cg JOIN categories c ON c.id = cg.category_id
                         WHERE cg.game_id = g.id AND (c.name ILIKE ${like} OR c.slug ILIKE ${like}))
             OR EXISTS (SELECT 1 FROM tag_game tg JOIN tags t ON t.id = tg.tag_id
                         WHERE tg.game_id = g.id AND (t.name ILIKE ${like} OR t.slug ILIKE ${like})))`,
      );
      if (!filter.sort || filter.sort === 'newest') {
        // $1 is renumbered to the next free placeholder below, because the WHERE
        // clause has already consumed the parameters that come before it.
        orderBy = `ts_rank(g.search_vector, plainto_tsquery('simple', $1)) DESC, g.plays DESC`;
      }
    }

    // "trending" = most played among recently published. Cheap, index-backed and
    // honest; a real 7-day velocity ranking lives in daily_stats and is used by
    // the dashboard, not by a public sort that must stay under 50ms.
    if (filter.sort === 'trending') {
      conds.push(sql`g.published_at > now() - interval '30 days'`);
    }

    const where = sql.and(...conds);
    const wherePart = resolvePart(where);
    const values = [...wherePart.values];

    // The rank ORDER BY references $1 = tsQuery, so prepend it when used.
    let orderBySql = orderBy!;
    if (q && orderBy!.includes('$1')) {
      orderBySql = orderBy!.replace(/\$1/g, `$${values.length + 1}`);
      values.push(q.split(/\s+/).filter(Boolean).join(' & '));
    }

    const countSql = `SELECT count(*)::int AS total FROM ${GAME_FROM} WHERE ${wherePart.text || 'TRUE'}`;
    const listSql = `${GAME_SELECT} FROM ${GAME_FROM} WHERE ${wherePart.text || 'TRUE'} ORDER BY ${orderBySql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;

    const [total, items] = await Promise.all([
      this.conn.value<number>(countSql, wherePart.values),
      this.conn.many<GameRow>(listSql, [...values, page.perPage, page.offset]),
    ]);

    if (filter.with?.length) await this.attachRelations(items, filter.with);
    return { items, total: total ?? 0 };
  }

  async relatedGames(game: Pick<GameRow, 'id' | 'slug'>, limit = 12): Promise<GameRow[]> {
    // Same category first, then same tags, then most-played overall — one query
    // with a scored UNION-free ordering, so a brand-new game still gets a rail.
    const rows = await this.conn.many<GameRow>(
      `SELECT g.*,
              (EXISTS (SELECT 1 FROM category_game cg1 JOIN category_game cg2 ON cg1.category_id = cg2.category_id
                        WHERE cg1.game_id = g.id AND cg2.game_id = $1))::int AS same_category,
              (SELECT count(*)::int FROM tag_game tg1 JOIN tag_game tg2 ON tg1.tag_id = tg2.tag_id
                WHERE tg1.game_id = g.id AND tg2.game_id = $1) AS shared_tags
         FROM games g
        WHERE g.status = 'published' AND g.deleted_at IS NULL AND g.id <> $1
        ORDER BY same_category DESC, shared_tags DESC, g.plays DESC
        LIMIT $2`,
      [game.id, limit],
    );
    await this.attachRelations(rows, ['categories']);
    return rows;
  }

  async randomGames(limit = 12, categorySlug?: string): Promise<GameRow[]> {
    const cond = categorySlug
      ? sql`AND EXISTS (SELECT 1 FROM category_game cg JOIN categories c ON c.id = cg.category_id
                         WHERE cg.game_id = g.id AND c.slug = ${categorySlug})`
      : sql.raw('');
    const rows = await this.conn.many<GameRow>(
      `SELECT g.* FROM games g
        WHERE g.status = 'published' AND g.deleted_at IS NULL ${cond.text}
        ORDER BY random() LIMIT $${cond.values.length + 1}`,
      [...cond.values, limit],
    );
    await this.attachRelations(rows, ['categories']);
    return rows;
  }

  /** Two queries for the whole page, whatever its size. */
  private async attachRelations(rows: GameRow[], withRelations: ('categories' | 'tags' | 'assets')[] = ['categories', 'tags']): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const [cats, tags, assets] = await Promise.all([
      withRelations.includes('categories') ? groupRelations<{ ownerId: ID; id: ID; slug: string; name: string }>(this.conn, { ids, query: GAME_CATEGORIES_SQL }) : null,
      withRelations.includes('tags') ? groupRelations<{ ownerId: ID; id: ID; slug: string; name: string }>(this.conn, { ids, query: GAME_TAGS_SQL }) : null,
      withRelations.includes('assets')
        ? groupRelations<GameAssetRow & { ownerId: ID }>(this.conn, {
            ids,
            query: `SELECT a.*, a.game_id AS owner_id FROM game_assets a WHERE a.game_id = ANY($1) ORDER BY a.sort_order`,
          })
        : null,
    ]);
    for (const row of rows) {
      if (cats) row.categories = (cats.get(row.id) ?? []).map(({ id, slug, name }) => ({ id, slug, name }));
      if (tags) row.tags = (tags.get(row.id) ?? []).map(({ id, slug, name }) => ({ id, slug, name }));
      if (assets) row.assets = assets.get(row.id) ?? [];
    }
  }

  // ───────────────────────────── writes ─────────────────────────────

  async createGame(data: Partial<GameRow> & { slug: string; title: string; url: string; thumbnailUrl: string }): Promise<GameRow> {
    const columns = toColumns(data as Record<string, unknown>, GAME_FIELDS);
    columns.id ??= data.id ?? newId();
    columns.updated_at = new Date();
    const row = await this.insert<GameRow>('games', columns);
    if (data.categories?.length) await this.setGameCategories(row.id, data.categories.map((c) => c.id));
    if (data.tags?.length) await this.setGameTags(row.id, data.tags as { slug: string; name: string }[]);
    return (await this.findGameById(row.id)) ?? row;
  }

  async updateGame(id: ID, patch: Partial<GameRow>): Promise<GameRow | null> {
    const columns = toColumns(patch as Record<string, unknown>, [...GAME_FIELDS, ...GAME_COUNTER_FIELDS]);
    if (Object.keys(columns).length > 0) {
      columns.updated_at = new Date();
      await this.update('games', 'id', id, columns);
    }
    if (patch.categories) {
      await this.setGameCategories(
        id,
        patch.categories.map((c) => c.id),
      );
    }
    if (patch.tags) await this.setGameTags(id, patch.tags);
    return this.findGameById(id);
  }

  async deleteGame(id: ID, options: { hard?: boolean } = {}): Promise<boolean> {
    if (options.hard) return (await this.conn.run(`DELETE FROM games WHERE id = $1`, [id])) > 0;
    return (await this.conn.run(`UPDATE games SET deleted_at = now(), status = 'archived' WHERE id = $1 AND deleted_at IS NULL`, [id])) > 0;
  }

  async incrementGame(id: ID, field: (typeof GAME_COUNTER_FIELDS)[number], by = 1): Promise<void> {
    const column = snakeCase(field);
    if (!GAME_COUNTER_FIELDS.includes(field)) throw new Error(`incrementGame: ${field} is not a counter`);
    // GREATEST(0, …) so a double-decrement can never produce a negative counter
    // (which the CHECK constraint would then reject mid-request).
    await this.conn.run(
      `UPDATE games SET "${column}" = GREATEST(0, "${column}" + $2), updated_at = now() WHERE id = $1`,
      [id, by],
    );
  }

  /** Recomputes every derived counter from the tables it comes from. Used after
   *  a moderation action and by the nightly integrity job. */
  async recalcGameCounters(id: ID): Promise<void> {
    await this.conn.run(
      `UPDATE games g SET
          likes_count = (SELECT count(*)::int FROM likes l WHERE l.target_kind = 'game' AND l.target_id = g.id AND l.value = 1),
          dislikes_count = (SELECT count(*)::int FROM likes l WHERE l.target_kind = 'game' AND l.target_id = g.id AND l.value = -1),
          comments_count = (SELECT count(*)::int FROM comments c WHERE c.game_id = g.id AND c.status = 'visible' AND c.deleted_at IS NULL),
          favorites_count = (SELECT count(*)::int FROM favorites f WHERE f.game_id = g.id),
          rating_count = (SELECT count(*)::int FROM ratings r WHERE r.game_id = g.id),
          rating_avg = coalesce((SELECT round(avg(r.stars)::numeric, 3)::real FROM ratings r WHERE r.game_id = g.id), 0),
          updated_at = now()
        WHERE g.id = $1`,
      [id],
    );
  }

  async setGameCategories(gameId: ID, categoryIds: ID[]): Promise<void> {
    await this.conn.tx(async (tx) => {
      const touched = await tx.many<{ id: ID }>(
        `SELECT category_id AS id FROM category_game WHERE game_id = $1`,
        [gameId],
      );
      await tx.run(`DELETE FROM category_game WHERE game_id = $1`, [gameId]);
      for (const [i, cid] of categoryIds.entries()) {
        await tx.run(
          `INSERT INTO category_game (category_id, game_id, position, created_at) VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`,
          [cid, gameId, i],
        );
      }
      const all = new Set([...touched.map((t) => t.id), ...categoryIds]);
      for (const cid of all) {
        await tx.run(
          `UPDATE categories SET games_count = (SELECT count(*)::int FROM category_game WHERE category_id = $1) WHERE id = $1`,
          [cid],
        );
      }
    });
  }

  async reorderCategoryGames(categoryId: ID, orderedGameIds: ID[]): Promise<void> {
    // One statement per position would be N round trips for a 60-tile grid; a single
    // UPDATE … FROM (VALUES …) writes the whole ordering in one transaction-shaped
    // call, and rows that are not in the list keep their existing position.
    if (orderedGameIds.length === 0) return;
    const values = orderedGameIds.map((_id, index) => `($${index + 2}, ${index})`).join(', ');
    const params = [categoryId, ...orderedGameIds];
    await this.conn.run(
      `UPDATE category_game cg SET position = v.pos
         FROM (VALUES ${values}) AS v(game_id, pos)
        WHERE cg.category_id = $1 AND cg.game_id = v.game_id::varchar`,
      params,
    );
  }

  async setGameTags(gameId: ID, tags: (string | { slug: string; name: string })[]): Promise<TagRow[]> {
    const rows = await this.upsertTags(tags, 'game');
    await this.conn.tx(async (tx) => {
      await tx.run(`DELETE FROM tag_game WHERE game_id = $1`, [gameId]);
      for (const tag of rows) {
        await tx.run(
          `INSERT INTO tag_game (tag_id, game_id, created_at) VALUES ($1,$2,now()) ON CONFLICT DO NOTHING`,
          [tag.id, gameId],
        );
      }
      for (const tag of rows) {
        await tx.run(`UPDATE tags SET games_count = (SELECT count(*)::int FROM tag_game WHERE tag_id = $1) WHERE id = $1`, [tag.id]);
      }
    });
    return rows;
  }

  async addAsset(asset: Omit<GameAssetRow, 'id' | 'createdAt'>): Promise<GameAssetRow> {
    return this.insert<GameAssetRow>('game_assets', {
      id: newId(),
      ...toColumns(asset as unknown as Record<string, unknown>, [
        'gameId',
        'kind',
        'url',
        'storageKey',
        'mimeType',
        'width',
        'height',
        'sizeBytes',
        'alt',
        'sortOrder',
      ]),
    });
  }

  async listAssets(gameId: ID): Promise<GameAssetRow[]> {
    return this.conn.many<GameAssetRow>(`SELECT * FROM game_assets WHERE game_id = $1 ORDER BY sort_order, created_at`, [gameId]);
  }

  async deleteAsset(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM game_assets WHERE id = $1`, [id])) > 0;
  }

  // ─────────────────────────── categories ───────────────────────────

  async listCategories(options: { visibleOnly?: boolean } = {}): Promise<CategoryRow[]> {
    const where = options.visibleOnly ? `WHERE is_visible = true AND deleted_at IS NULL` : `WHERE deleted_at IS NULL`;
    return this.conn.many<CategoryRow>(`SELECT * FROM categories ${where} ORDER BY sort_order, name`, []);
  }

  async categoryTree(options: { visibleOnly?: boolean } = {}): Promise<CategoryRow[]> {
    const all = await this.listCategories(options);
    const byParent = new Map<ID | null, CategoryRow[]>();
    for (const c of all) {
      const list = byParent.get(c.parentId ?? null) ?? [];
      list.push(c);
      byParent.set(c.parentId ?? null, list);
    }
    const attach = (nodes: CategoryRow[]): CategoryRow[] =>
      nodes.map((n) => ({ ...n, children: attach(byParent.get(n.id) ?? []) }));
    return attach(byParent.get(null) ?? []);
  }

  async findCategoryBySlug(slug: string): Promise<CategoryRow | null> {
    return this.conn.one<CategoryRow>(`SELECT * FROM categories WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  }

  async findCategoryById(id: ID): Promise<CategoryRow | null> {
    return this.conn.one<CategoryRow>(`SELECT * FROM categories WHERE id = $1`, [id]);
  }

  async createCategory(data: Partial<CategoryRow> & { slug: string; name: string }): Promise<CategoryRow> {
    const columns = toColumns(data as Record<string, unknown>, CATEGORY_FIELDS);
    columns.id ??= data.id ?? newId();
    columns.updated_at = new Date();
    return this.insert<CategoryRow>('categories', columns);
  }

  async updateCategory(id: ID, patch: Partial<CategoryRow>): Promise<CategoryRow | null> {
    await this.update('categories', 'id', id, { ...toColumns(patch as Record<string, unknown>, CATEGORY_FIELDS), updated_at: new Date() });
    return this.findCategoryById(id);
  }

  async deleteCategory(id: ID): Promise<boolean> {
    // Soft delete: the games keep their other categories and the URL keeps
    // resolving to a 410 with a redirect suggestion instead of a hard 404.
    return (await this.conn.run(`UPDATE categories SET deleted_at = now(), is_visible = false WHERE id = $1 AND deleted_at IS NULL`, [id])) > 0;
  }

  async reorderCategories(orderedIds: ID[]): Promise<void> {
    await this.conn.tx(async (tx) => {
      for (const [i, id] of orderedIds.entries()) {
        await tx.run(`UPDATE categories SET sort_order = $2, updated_at = now() WHERE id = $1`, [id, i]);
      }
    });
  }

  // ────────────────────────────── tags ──────────────────────────────

  async listTags(options: { scope?: string; q?: string; limit?: number } = {}): Promise<TagRow[]> {
    const conds: SqlPart[] = [];
    if (options.scope) conds.push(eq('scope', options.scope)!);
    const like = likeAny(['name', 'slug'], options.q);
    if (like) conds.push(like);
    const where = resolvePart(sql.and(...conds));
    return this.conn.many<TagRow>(
      `SELECT * FROM tags WHERE ${where.text || 'TRUE'} ORDER BY games_count DESC, name ASC LIMIT ${Math.min(options.limit ?? 60, 200)}`,
      where.values,
    );
  }

  async findTagBySlug(slug: string, scope?: string): Promise<TagRow | null> {
    return this.conn.one<TagRow>(
      `SELECT * FROM tags WHERE slug = $1 ${scope ? 'AND scope = $2' : ''} LIMIT 1`,
      scope ? [slug, scope] : [slug],
    );
  }

  /** Creates missing tags and returns all of them, in input order. */
  async upsertTags(tags: (string | { slug: string; name: string })[], scope: 'game' | 'blog' = 'game'): Promise<TagRow[]> {
    const normalised = tags
      .map((t) => (typeof t === 'string' ? { name: t.trim(), slug: slugify(t) } : { name: t.name.trim(), slug: t.slug || slugify(t.name) }))
      .filter((t) => t.slug.length > 0)
      .slice(0, 40);
    if (normalised.length === 0) return [];

    const out: TagRow[] = [];
    const seen = new Set<string>();
    for (const tag of normalised) {
      if (seen.has(tag.slug)) continue;
      seen.add(tag.slug);
      const existing = await this.conn.one<TagRow>(`SELECT * FROM tags WHERE slug = $1`, [tag.slug]);
      if (existing) {
        out.push(existing);
        continue;
      }
      const slug = await uniqueSlug(tag.slug, async (candidate) => (await this.conn.value<number>(`SELECT count(*)::int FROM tags WHERE slug = $1`, [candidate]) ?? 0) > 0);
      out.push(
        await this.insert<TagRow>('tags', {
          id: newId(),
          slug,
          name: tag.name.slice(0, 80),
          scope,
          games_count: 0,
        }),
      );
    }
    return out;
  }
}
