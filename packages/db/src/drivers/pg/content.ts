/**
 * SQL driver — CMS content: static pages (page-builder JSON) and the blog.
 *
 * Posts store Markdown, not HTML. Rendering happens in the web app, so there is
 * no stored-XSS surface: a compromised editor account cannot plant a script that
 * every visitor executes.
 */

import { slugify } from '@voltade/shared';
import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type {
  BlogCategoryRow,
  BlogPostRow,
  ContentRepository,
  ID,
  List,
  PageRow,
  TagRow,
} from '../../ports.js';
import { POST_TAGS_SQL, PgRepo, eq, escapeLike, groupRelations, newId, pageOf, toColumns } from './helpers.js';

const PAGE_FIELDS = [
  'slug',
  'title',
  'titleEn',
  'body',
  'blocks',
  'template',
  'status',
  'isIndexed',
  'seoTitle',
  'seoDescription',
  'canonicalUrl',
  'sortOrder',
  'deletedAt',
] as const;

const POST_FIELDS = [
  'slug',
  'title',
  'excerpt',
  'body',
  'coverImage',
  'authorId',
  'categoryId',
  'status',
  'publishedAt',
  'readingMinutes',
  'views',
  'seoTitle',
  'seoDescription',
  'canonicalUrl',
  'deletedAt',
] as const;

const POST_SELECT = `
  SELECT p.*, jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'avatarUrl', u.avatar_url) AS author,
         CASE WHEN bc.id IS NULL THEN NULL ELSE jsonb_build_object('id', bc.id, 'slug', bc.slug, 'name', bc.name) END AS category
    FROM blog_posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN blog_categories bc ON bc.id = p.category_id`;

export class PgContentRepository extends PgRepo implements ContentRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  // ──────────────────────────────── pages ────────────────────────────────

  async findPageBySlug(slug: string): Promise<PageRow | null> {
    return this.conn.one<PageRow>(`SELECT * FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  }

  async findPageById(id: ID, options: { includeDeleted?: boolean } = {}): Promise<PageRow | null> {
    const alive = options.includeDeleted ? '' : ' AND deleted_at IS NULL';
    return this.conn.one<PageRow>(`SELECT * FROM pages WHERE id = $1${alive}`, [id]);
  }

  async restorePage(id: ID): Promise<PageRow | null> {
    await this.conn.run(`UPDATE pages SET deleted_at = NULL, updated_at = now() WHERE id = $1`, [id]);
    return this.findPageById(id, { includeDeleted: true });
  }

  async listPages(filter: {
    status?: string;
    includeDeleted?: boolean;
    page?: { page: number; perPage: number; offset: number };
  } = {}): Promise<List<PageRow>> {
    const conds: SqlPart[] = filter.includeDeleted ? [] : [sql`deleted_at IS NULL`];
    // Pages are not scheduled, so for a page 'live' simply means 'published'; 'any'
    // drops the status filter altogether for the admin list.
    if (filter.status === 'any') { /* no status condition */ } else if (filter.status === 'live') conds.push(eq('status', 'published')!);
    else if (filter.status) conds.push(eq('status', filter.status)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 25);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM pages WHERE ${where.text}`, where.values)) ?? 0;
    const items = await this.conn.many<PageRow>(
      `SELECT * FROM pages WHERE ${where.text} ORDER BY sort_order, title LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items, total };
  }

  async createPage(data: Partial<PageRow> & { slug: string; title: string }): Promise<PageRow> {
    const columns = toColumns(data, PAGE_FIELDS);
    columns.id = data.id ?? newId();
    columns.updated_at = new Date();
    if (data.blocks && !columns.blocks) columns.blocks = JSON.stringify(data.blocks);
    return this.insert<PageRow>('pages', columns);
  }

  async updatePage(id: ID, patch: Partial<PageRow>): Promise<PageRow | null> {
    const columns = toColumns(patch, PAGE_FIELDS);
    if (patch.blocks) columns.blocks = JSON.stringify(patch.blocks);
    if (Object.keys(columns).length > 0) {
      columns.updated_at = new Date();
      await this.update('pages', 'id', id, columns);
    }
    return this.conn.one<PageRow>(`SELECT * FROM pages WHERE id = $1`, [id]);
  }

  async deletePage(id: ID, options: { hard?: boolean } = {}): Promise<boolean> {
    if (options.hard) return (await this.conn.run(`DELETE FROM pages WHERE id = $1`, [id])) > 0;
    return (await this.conn.run(`UPDATE pages SET deleted_at = now(), status = 'archived' WHERE id = $1`, [id])) > 0;
  }

  // ─────────────────────────── blog categories ───────────────────────────

  async listBlogCategories(): Promise<BlogCategoryRow[]> {
    // posts_count is computed here rather than read from the stored column: a scheduled
    // post becomes live when the clock passes its published_at, and no write happens at
    // that moment to refresh a denormalised counter. Blog categories number in the tens,
    // so a correlated subquery costs nothing and cannot be wrong.
    return this.conn.many<BlogCategoryRow>(`
      SELECT bc.id, bc.slug, bc.name, bc.description, bc.parent_id, bc.sort_order, bc.created_at, bc.updated_at,
             (SELECT count(*)::int FROM blog_posts p
               WHERE p.category_id = bc.id AND p.deleted_at IS NULL
                 AND (p.status = 'published'
                      OR (p.status = 'scheduled' AND p.published_at IS NOT NULL AND p.published_at <= now()))
             ) AS posts_count
        FROM blog_categories bc
       ORDER BY bc.sort_order, bc.name`);
  }

  async createBlogCategory(data: Partial<BlogCategoryRow> & { slug: string; name: string }): Promise<BlogCategoryRow> {
    return this.insert<BlogCategoryRow>('blog_categories', {
      id: data.id ?? newId(),
      slug: data.slug || slugify(data.name),
      name: data.name,
      description: data.description ?? null,
      parent_id: data.parentId ?? null,
      sort_order: data.sortOrder ?? 0,
      posts_count: 0,
      updated_at: new Date(),
    });
  }

  async updateBlogCategory(id: ID, patch: Partial<BlogCategoryRow>): Promise<BlogCategoryRow | null> {
    await this.update('blog_categories', 'id', id, {
      ...toColumns(patch, ['slug', 'name', 'description', 'parentId', 'sortOrder']),
      updated_at: new Date(),
    });
    return this.conn.one<BlogCategoryRow>(`SELECT * FROM blog_categories WHERE id = $1`, [id]);
  }

  async deleteBlogCategory(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM blog_categories WHERE id = $1`, [id])) > 0;
  }

  // ─────────────────────────────── posts ───────────────────────────────

  async listPosts(filter: {
    status?: string;
    categorySlug?: string;
    tagSlug?: string;
    q?: string;
    sort?: 'newest' | 'popular';
    author?: string;
    includeDeleted?: boolean;
    page?: { page: number; perPage: number; offset: number };
  } = {}): Promise<List<BlogPostRow>> {
    const conds: SqlPart[] = filter.includeDeleted ? [] : [sql`p.deleted_at IS NULL`];
    if (filter.status === 'any') {
      // The admin list sees every status; a default here would silently hide drafts.
    } else if (filter.status === 'live') {
      // "Live" is evaluated by the query, not by a cron job: a scheduled post appears
      // the instant its published_at passes, and there is no worker that can be down,
      // late or silently skipped. The trade is one extra OR in the WHERE clause, which
      // the (status, published_at DESC) index still covers.
      conds.push(sql`(p.status = 'published' OR (p.status = 'scheduled' AND p.published_at IS NOT NULL AND p.published_at <= now()))`);
    } else {
      conds.push(sql`p.status = ${filter.status ?? 'published'}`);
    }
    if (filter.categorySlug) conds.push(eq('bc.slug', filter.categorySlug)!);
    if (filter.tagSlug) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM blog_post_tag bt JOIN tags t ON t.id = bt.tag_id WHERE bt.post_id = p.id AND t.slug = ${filter.tagSlug})`,
      );
    }
    if (filter.author?.trim()) {
      const author = filter.author.trim();
      conds.push(sql`(u.username = ${author} OR p.author_id = ${author})`);
    }
    if (filter.q?.trim()) {
      const q = filter.q.trim();
      conds.push(
        sql`(p.search_vector @@ plainto_tsquery('simple', ${q}) OR p.title ILIKE ${`%${escapeLike(q)}%`} OR p.excerpt ILIKE ${`%${escapeLike(q)}%`})`,
      );
    }
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 12);
    const from = `blog_posts p JOIN users u ON u.id = p.author_id LEFT JOIN blog_categories bc ON bc.id = p.category_id`;
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM ${from} WHERE ${where.text}`, where.values)) ?? 0;
    const items = await this.conn.many<BlogPostRow>(
      `${POST_SELECT} WHERE ${where.text} ORDER BY ${
        filter.sort === 'popular' ? 'p.views DESC, p.published_at DESC NULLS LAST' : 'p.published_at DESC NULLS LAST, p.created_at DESC'
      }
        LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items: items.map(mapPost), total };
  }

  async findPostBySlug(slug: string): Promise<BlogPostRow | null> {
    return this.loadPost(`${POST_SELECT} WHERE p.slug = $1 AND p.deleted_at IS NULL`, [slug]);
  }

  async findPostById(id: ID, options: { includeDeleted?: boolean } = {}): Promise<BlogPostRow | null> {
    const alive = options.includeDeleted ? '' : ' AND p.deleted_at IS NULL';
    return this.loadPost(`${POST_SELECT} WHERE p.id = $1${alive}`, [id]);
  }

  async restorePost(id: ID): Promise<BlogPostRow | null> {
    const row = await this.conn.one<{ categoryId: ID | null }>(
      `UPDATE blog_posts SET deleted_at = NULL, updated_at = now() WHERE id = $1 RETURNING category_id AS "categoryId"`,
      [id],
    );
    if (!row) return null;
    // The category's published-post count excludes deleted rows, so restoring changes it.
    if (row.categoryId) await this.syncCategoryCount(row.categoryId);
    return this.findPostById(id, { includeDeleted: true });
  }

  /** One row plus its tags. Shared by the slug and id lookups so they cannot drift. */
  private async loadPost(query: string, params: unknown[]): Promise<BlogPostRow | null> {
    const row = await this.conn.one<BlogPostRow>(query, params);
    if (!row) return null;
    const post = mapPost(row);
    const tags = await groupRelations<{ ownerId: ID; id: ID; slug: string; name: string }>(this.conn, {
      ids: [post.id],
      query: POST_TAGS_SQL,
    });
    post.tags = (tags.get(post.id) ?? []).map(({ id, slug: s, name }) => ({ id, slug: s, name }));
    return post;
  }

  async createPost(data: Partial<BlogPostRow> & { slug: string; title: string; body: string; authorId: ID }): Promise<BlogPostRow> {
    const columns = toColumns(data, POST_FIELDS);
    columns.id = data.id ?? newId();
    columns.updated_at = new Date();
    if (data.tags?.length) {
      // tags are attached after insert (join table needs the post id)
    }
    const row = await this.insert<BlogPostRow>('blog_posts', columns);
    if (data.tags?.length) await this.setPostTags(row.id, data.tags);
    if (row.categoryId) await this.syncCategoryCount(row.categoryId);
    return (await this.findPostBySlug(row.slug)) ?? row;
  }

  async updatePost(id: ID, patch: Partial<BlogPostRow>): Promise<BlogPostRow | null> {
    const columns = toColumns(patch, POST_FIELDS);
    // Read the category it is leaving *before* the write: moving a post changes two
    // counters, and re-syncing only the destination leaves the old category claiming a
    // post that is no longer there — which then blocks deleting that category.
    const previous = await this.conn.one<{ categoryId: ID | null }>(
      `SELECT category_id AS "categoryId" FROM blog_posts WHERE id = $1`,
      [id],
    );
    if (Object.keys(columns).length > 0) {
      columns.updated_at = new Date();
      await this.update('blog_posts', 'id', id, columns);
    }
    if (patch.tags) await this.setPostTags(id, patch.tags);
    const post = await this.conn.one<BlogPostRow>(`SELECT * FROM blog_posts WHERE id = $1`, [id]);
    if (post?.categoryId) await this.syncCategoryCount(post.categoryId);
    if (previous?.categoryId && previous.categoryId !== post?.categoryId) await this.syncCategoryCount(previous.categoryId);
    return post ? this.findPostBySlug(post.slug) : null;
  }

  /** Soft delete keeps the row (and its slug) out of every read path until restored. */
  async deletePost(id: ID, options: { hard?: boolean } = {}): Promise<boolean> {
    const post = await this.conn.one<{ categoryId: ID | null }>(`SELECT category_id AS "categoryId" FROM blog_posts WHERE id = $1`, [id]);
    const ok = options.hard
      ? (await this.conn.run(`DELETE FROM blog_posts WHERE id = $1`, [id])) > 0
      : (await this.conn.run(`UPDATE blog_posts SET deleted_at = now(), status = 'archived' WHERE id = $1`, [id])) > 0;
    if (ok && post?.categoryId) await this.syncCategoryCount(post.categoryId);
    return ok;
  }

  async incrementPostViews(id: ID): Promise<void> {
    await this.conn.run(`UPDATE blog_posts SET views = views + 1 WHERE id = $1`, [id]);
  }

  async setPostTags(postId: ID, tags: (string | { slug: string; name: string })[]): Promise<TagRow[]> {
    const rows = await this.upsertBlogTags(tags);
    await this.conn.tx(async (tx) => {
      await tx.run(`DELETE FROM blog_post_tag WHERE post_id = $1`, [postId]);
      for (const tag of rows) {
        await tx.run(`INSERT INTO blog_post_tag (post_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [postId, tag.id]);
      }
      for (const tag of rows) {
        await tx.run(`UPDATE tags SET games_count = (SELECT count(*)::int FROM blog_post_tag WHERE tag_id = $1) WHERE id = $1`, [tag.id]);
      }
    });
    return rows;
  }

  async relatedPosts(postId: ID, limit = 4): Promise<BlogPostRow[]> {
    const rows = await this.conn.many<BlogPostRow>(
      `${POST_SELECT}
        WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.id <> $1
          AND (p.category_id = (SELECT category_id FROM blog_posts WHERE id = $1)
               OR EXISTS (SELECT 1 FROM blog_post_tag a JOIN blog_post_tag b ON a.tag_id = b.tag_id
                           WHERE a.post_id = p.id AND b.post_id = $1))
        ORDER BY p.published_at DESC LIMIT $2`,
      [postId, limit],
    );
    return rows.map(mapPost);
  }

  private async upsertBlogTags(tags: (string | { slug: string; name: string })[]): Promise<TagRow[]> {
    const out: TagRow[] = [];
    for (const t of tags.slice(0, 20)) {
      const name = typeof t === 'string' ? t.trim() : t.name.trim();
      const slug = slugify(typeof t === 'string' ? t : t.slug || t.name);
      if (!slug) continue;
      const existing = await this.conn.one<TagRow>(`SELECT * FROM tags WHERE slug = $1`, [slug]);
      if (existing) {
        out.push(existing);
        continue;
      }
      out.push(await this.insert<TagRow>('tags', { id: newId(), slug, name: name.slice(0, 80), scope: 'blog', games_count: 0 }));
    }
    return out;
  }

  /** The stored counter kept in step with the same "live" definition listBlogCategories uses. */
  private async syncCategoryCount(categoryId: ID): Promise<void> {
    await this.conn.run(
      `UPDATE blog_categories SET posts_count = (
         SELECT count(*)::int FROM blog_posts
          WHERE category_id = $1 AND deleted_at IS NULL
            AND (status = 'published' OR (status = 'scheduled' AND published_at IS NOT NULL AND published_at <= now()))
       ) WHERE id = $1`,
      [categoryId],
    );
  }
}

function mapPost(row: BlogPostRow & { author?: unknown; category?: unknown }): BlogPostRow {
  const author = row.author as Record<string, unknown> | undefined;
  const category = row.category as Record<string, unknown> | undefined;
  return {
    ...row,
    author: author
      ? {
          id: String(author.id ?? ''),
          username: String(author.username ?? ''),
          displayName: (author.displayName as string | null) ?? null,
          avatarUrl: (author.avatarUrl as string | null) ?? null,
        }
      : undefined,
    category: category && category.id
      ? { id: String(category.id), slug: String(category.slug ?? ''), name: String(category.name ?? '') }
      : null,
  };
}

