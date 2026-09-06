/**
 * CMS: the blog (posts, categories, tags) and the page builder.
 *
 * EIGHT DECISIONS SHAPE THIS FILE:
 *
 * 1. MARKDOWN IN, HTML OUT. A post body is stored exactly as the editor wrote it and
 *    rendered by the web app. Stored HTML would be a stored-XSS surface where one
 *    compromised editor account plants a script that every visitor runs; stored
 *    Markdown cannot execute anything until a renderer we control decides what it
 *    means.
 *
 * 2. SCHEDULING IS DATA, NOT A JOB. A post with status=scheduled and a future
 *    publishedAt becomes visible the instant that time passes, because the read query
 *    evaluates it (`status = 'live'`). There is no worker to be down, late, or
 *    silently skipped — the failure mode of every cron-based scheduler.
 *
 * 3. `publishedAt` IS WRITTEN ONCE. Later edits never move it: datePublished is a
 *    promise to a search engine and to the archive, dateModified is the honest
 *    counter beside it. Unpublishing keeps the original date, so re-publishing
 *    restores it instead of pretending the post is new.
 *
 * 4. A TAKEN SLUG IS A 409, NOT A SILENT RENAME. The slug is the URL an editor
 *    announced, linked and indexed; quietly turning `/blog/x` into `/blog/x-2` is how
 *    a CMS ends up with two competing URLs for one story. When the slug is *derived*
 *    from the title, nobody promised anything, so it is de-duplicated with a suffix.
 *
 * 5. PAGES LIVE AT `/{slug}` — the shortest, most crawlable URL there is — which is
 *    only safe because a slug that would shadow an application route (`games`,
 *    `admin`, `blog`, …) is refused at write time.
 *
 * 6. ONE VIEW PER VISITOR PER HOUR, keyed by the play-session cookie and falling back
 *    to the IP. A refresh button is not an audience, and an inflated counter is a
 *    number nobody can trust again.
 *
 * 7. STAFF PREVIEWS ARE NEVER CACHED. A draft shown to its author must not land in a
 *    key an anonymous visitor can be served from; that single mistake is how
 *    unpublished content leaks.
 *
 * 8. AN `html` PAGE BLOCK IS SANITISED. Markup, yes; code, no. The one deliberately
 *    unsanitised HTML on the site stays `integrations.headHtml` (analytics and ad
 *    tags), which requires `settings.manage` and is audited.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BlogCategoryRow, BlogPostRow, Database, PageRow } from '@voltade/db';
import {
  CACHE,
  ContentStatus,
  blogPostingJsonLd,
  breadcrumbJsonLd,
  faqJsonLd,
  findUnsafeHtml,
  plainExcerpt,
  readingMinutes,
  safeUrl,
  sanitizeHtml,
  slugify,
  uniqueSlug,
} from '@voltade/shared';
import { AuditService } from '../../common/audit/audit.service.js';
import { DATABASE } from '../../common/database/database.module.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { AppError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { absoluteUrl } from '../../common/http/urls.js';
import type { RequestUser } from '../../common/decorators/index.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import type {
  AdminPageListQueryDto,
  AdminPostListQueryDto,
  CreatePostDto,
  PageBlockDto,
  PostListQueryDto,
  UpdatePostDto,
  UpsertBlogCategoryDto,
  UpsertPageDto,
} from './dto/cms.dto.js';

const MAX_HTML_LENGTH = 200_000;
const MAX_FAQ_ITEMS = 30;

/**
 * Slugs a page may not take, because the web app owns those paths. Checked on write
 * rather than discovered at render time as a page that can never be reached.
 */
const RESERVED_PAGE_SLUGS = new Set([
  'admin', 'api', 'blog', 'category', 'categories', 'game', 'games', 'play', 'playlist', 'playlists',
  'profile', 'search', 'settings', 'tag', 'tags', 'user', 'users', 'leaderboard', 'login', 'register',
  'signup', 'signin', 'me', 'feed', 'rss', 'sitemap', 'robots', 'about-us', 'contact-us', 'page', 'pages',
]);

/** URL builders — the single place that knows the web app's route shape. */
const postPath = (slug: string): string => `/blog/${slug}`;
const pagePath = (slug: string): string => `/${slug}`;
const categoryPath = (slug: string): string => `/blog/category/${slug}`;

export type TermRef = { slug: string; name: string };
export type AuthorRef = { username: string; displayName: string | null; avatarUrl: string | null };

export type PostCard = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  coverImage: string | null;
  url: string;
  author: AuthorRef | null;
  category: TermRef | null;
  status: string;
  /** True when a scheduled post's time has come — what the visitor actually sees. */
  live: boolean;
  publishedAt: string | null;
  updatedAt: string;
  readingMinutes: number;
  views: number;
  /**
   * Always null on a public payload (a deleted row is never live). It is here so the
   * admin grid and the public card share one shape — one TypeScript type in the web
   * app instead of two that drift apart the first time a field is added.
   */
  deletedAt: string | null;
};

export type PostView = PostCard & {
  body: string;
  tags: TermRef[];
  seo: { title: string | null; description: string | null; canonical: string | null; robots: string };
  jsonLd: Record<string, unknown>[];
  related: PostCard[];
  preview: boolean;
};

export type PageBlock = { id: string; type: string; props: Record<string, unknown> };

export type PageView = {
  id: string;
  slug: string;
  title: string;
  titleEn: string | null;
  url: string;
  template: string;
  status: string;
  live: boolean;
  body: string | null;
  blocks: PageBlock[];
  isIndexed: boolean;
  sortOrder: number;
  updatedAt: string;
  /** Non-null for an archived page; the admin list shows it and offers a restore. */
  deletedAt: string | null;
  seo: { title: string | null; description: string | null; canonical: string | null; robots: string };
  jsonLd: Record<string, unknown>[];
  preview: boolean;
};

export type BlogCategoryView = TermRef & {
  id: string;
  description: string | null;
  url: string;
  parentId: string | null;
  postsCount: number;
  sortOrder: number;
  children: BlogCategoryView[];
};

/** Is this row visible to an anonymous visitor right now? */
function isLive(row: { status: string; publishedAt?: Date | null }, now = new Date()): boolean {
  if (row.status === ContentStatus.published) return true;
  const at = row.publishedAt ?? null;
  return row.status === ContentStatus.scheduled && at !== null && at.getTime() <= now.getTime();
}

const iso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

@Injectable()
export class CmsService {
  private readonly logger = new Logger('cms');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── public: blog ─────────────────────────────

  /** Blog categories as a flat list and a tree — the sidebar and the nav both need one. */
  async blogCategories(): Promise<{ items: BlogCategoryView[]; tree: BlogCategoryView[] }> {
    const cacheKey = CACHE.key.blogCategories();
    const cached = await this.redis.getJson<{ items: BlogCategoryView[]; tree: BlogCategoryView[] }>(cacheKey);
    if (cached) return cached;

    const rows = await this.db.content.listBlogCategories();
    const items = rows.map((row) => this.categoryView(row));
    const byParent = new Map<string | null, BlogCategoryView[]>();
    for (const item of items) {
      const bucket = byParent.get(item.parentId) ?? [];
      bucket.push(item);
      byParent.set(item.parentId, bucket);
    }
    const attach = (nodes: BlogCategoryView[]): BlogCategoryView[] =>
      nodes.map((node) => ({ ...node, children: attach(byParent.get(node.id) ?? []) }));
    const out = { items, tree: attach(byParent.get(null) ?? []) };
    await this.redis.setJson(cacheKey, out, CACHE.ttl.blogCategories);
    return out;
  }

  /** Published (and due) posts, filtered by category/tag/query, newest or most-read first. */
  async posts(query: PostListQueryDto): Promise<{ items: PostCard[]; total: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const perPage = Math.min(60, Math.max(1, Number(query.perPage ?? 12)));
    const hash = [query.category ?? '', query.tag ?? '', query.q ?? '', query.sort ?? 'newest', page, perPage]
      .map((part) => String(part).trim().toLowerCase())
      .join('|');
    const version = (await this.redis.get(CACHE.key.postsVersion())) ?? '0';
    const cacheKey = CACHE.key.posts(version, hash);

    const cached = await this.redis.getJson<{ items: PostCard[]; total: number }>(cacheKey);
    if (cached) return cached;

    const result = await this.db.content.listPosts({
      status: 'live',
      categorySlug: query.category?.trim() || undefined,
      tagSlug: query.tag?.trim() || undefined,
      q: query.q?.trim() || undefined,
      sort: query.sort === 'popular' ? 'popular' : 'newest',
      page: { page, perPage, offset: (page - 1) * perPage },
    });
    const out = { items: result.items.map((row) => this.postCard(row)), total: result.total };
    await this.redis.setJson(cacheKey, out, CACHE.ttl.posts);
    return out;
  }

  /**
   * One post by slug.
   *
   * A visitor gets it only if it is live; a staff viewer (anyone holding `blog.view`)
   * also gets drafts, scheduled and archived posts, flagged `preview: true` so the web
   * app can show a banner and send `noindex`. Previews bypass the cache entirely.
   */
  async post(meta: RequestMeta, slug: string, viewer: RequestUser | null): Promise<PostView> {
    const row = await this.db.content.findPostBySlug(slug);
    if (!row) throw new AppError('post.not_found', `no post with the slug "${slug}"`, 404);

    const canPreview = hasPermission(viewer, 'blog.view');
    if (!isLive(row) && !canPreview) {
      // 404, not 403: telling an anonymous visitor that an unpublished post exists at
      // this URL leaks the editorial calendar for free.
      throw new AppError('post.not_found', `no post with the slug "${slug}"`, 404);
    }

    if (!isLive(row)) return this.buildPost(row, { related: false, preview: true });

    const cacheKey = CACHE.key.post(row.slug);
    const cached = await this.redis.getJson<PostView>(cacheKey);
    // The counter is incremented on every request, cached or not — caching the payload
    // must not cost us the views.
    const counted = await this.countView(row, meta);
    if (cached) {
      // `row.views` was read before the increment, so a cached payload would otherwise
      // show one view fewer than the database has. The database stays the source of
      // truth; this only keeps the number a reader sees from going backwards.
      const views = cached.views + (counted ? 1 : 0);
      return { ...cached, views, preview: canPreview ? false : cached.preview };
    }

    const view = await this.buildPost(row, { related: true, preview: false });
    if (counted) view.views += 1;
    await this.redis.setJson(cacheKey, view, CACHE.ttl.post);
    return view;
  }

  // ───────────────────────────── public: pages ────────────────────────────

  /** Published pages for the footer/nav: title, slug and order, nothing heavy. */
  async livePages(): Promise<{ items: Pick<PageView, 'id' | 'slug' | 'title' | 'titleEn' | 'url' | 'sortOrder'>[] }> {
    const cacheKey = CACHE.key.pages('live');
    const cached = await this.redis.getJson<{ items: Pick<PageView, 'id' | 'slug' | 'title' | 'titleEn' | 'url' | 'sortOrder'>[] }>(cacheKey);
    if (cached) return cached;

    const { items } = await this.db.content.listPages({ status: 'live', page: { page: 1, perPage: 100, offset: 0 } });
    const out = {
      items: items
        .filter((row) => !row.deletedAt)
        .map((row) => ({
          id: row.id,
          slug: row.slug,
          title: row.title,
          titleEn: row.titleEn,
          url: pagePath(row.slug),
          sortOrder: row.sortOrder,
        })),
    };
    await this.redis.setJson(cacheKey, out, CACHE.ttl.page);
    return out;
  }

  /** One page by slug, with its rendered-ready blocks and structured data. */
  async page(slug: string, viewer: RequestUser | null): Promise<PageView> {
    const row = await this.db.content.findPageBySlug(slug);
    if (!row) throw new AppError('page.not_found', `no page with the slug "${slug}"`, 404);

    const canPreview = hasPermission(viewer, 'pages.manage');
    const live = row.status === ContentStatus.published;
    if (!live && !canPreview) throw new AppError('page.not_found', `no page with the slug "${slug}"`, 404);
    if (!live) return this.buildPage(row, true);

    const cacheKey = CACHE.key.page(row.slug);
    const cached = await this.redis.getJson<PageView>(cacheKey);
    if (cached) return canPreview ? { ...cached, preview: false } : cached;
    const view = this.buildPage(row, false);
    await this.redis.setJson(cacheKey, view, CACHE.ttl.page);
    return view;
  }

  // ───────────────────────────── admin: posts ─────────────────────────────

  /** The editor's list: every status, an author filter, and the real `status` value. */
  async adminPosts(query: AdminPostListQueryDto): Promise<{ items: PostCard[]; total: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(query.perPage ?? 25)));
    // 'any' is a real filter value in the repository, not something assembled here:
    // merging four per-status pages in the service would make pagination approximate,
    // and an admin list that silently repeats or drops rows is worse than no list.
    const status = query.status?.trim() && query.status !== 'any' ? query.status : 'any';
    const result = await this.db.content.listPosts({
      status,
      categorySlug: query.category?.trim() || undefined,
      tagSlug: query.tag?.trim() || undefined,
      q: query.q?.trim() || undefined,
      author: query.author?.trim() || undefined,
      // "Everything" means everything an editor can act on, archive included: a
      // soft-deleted row that no list returns can never be restored or hard-deleted.
      includeDeleted: status === 'any',
      page: { page, perPage, offset: (page - 1) * perPage },
    });
    return { items: result.items.map((row) => this.postCard(row)), total: result.total };
  }

  async adminPost(actor: RequestUser, ref: string): Promise<PostView> {
    assertPermission(actor, 'blog.view');
    const row = await this.findPostByRef(ref);
    return this.buildPost(row, { related: false, preview: !isLive(row) });
  }

  async createPost(meta: RequestMeta, actor: RequestUser, dto: CreatePostDto): Promise<PostView> {
    assertPermission(actor, 'blog.create');
    const status = dto.status ?? ContentStatus.draft;
    assertPublishAllowed(actor, status);

    const category = await this.resolveCategory(dto.category);
    const slug = await this.resolvePostSlug(dto.slug, dto.title, null);
    const publishedAt = resolvePublishedAt(status, dto.publishAt, null);

    const created = await this.db.content.createPost({
      slug,
      title: dto.title.trim(),
      excerpt: dto.excerpt?.trim() || plainExcerpt(dto.body, 170) || null,
      body: dto.body,
      coverImage: safeUrlValue(dto.coverImage, 'post.coverImage'),
      authorId: actor.id,
      categoryId: category?.id ?? null,
      status,
      publishedAt,
      readingMinutes: readingMinutes(dto.body),
      views: 0,
      seoTitle: dto.seoTitle?.trim() || null,
      seoDescription: dto.seoDescription?.trim() || null,
      canonicalUrl: safeUrlValue(dto.canonicalUrl, 'post.canonicalUrl'),
    });
    if (dto.tags?.length) await this.db.content.setPostTags(created.id, dto.tags.map((tag) => tag.trim()).filter(Boolean));

    await this.invalidatePosts(created.slug);
    this.audit.record(meta, {
      action: 'blog.post.create',
      targetKind: 'blog_post',
      targetId: created.id,
      after: { slug: created.slug, title: created.title, status },
    });
    this.logger.log(`post created: ${created.slug} (${status}) by ${actor.username}`);
    return this.buildPost((await this.db.content.findPostBySlug(created.slug)) ?? created, {
      related: false,
      preview: !isLive(created),
    });
  }

  async updatePost(meta: RequestMeta, actor: RequestUser, ref: string, dto: UpdatePostDto): Promise<PostView> {
    assertPermission(actor, 'blog.update');
    const existing = await this.findPostByRef(ref);

    const nextStatus = dto.status ?? (existing.status as ContentStatus);
    // Moving anything *to* a visible state is publishing, and needs the publish right —
    // even though the request as a whole only claims `blog.update`.
    if (nextStatus !== existing.status) assertPublishAllowed(actor, nextStatus);
    if (dto.authorId && dto.authorId !== existing.authorId) assertPermission(actor, 'blog.publish');

    const slug = dto.slug && dto.slug !== existing.slug ? await this.resolvePostSlug(dto.slug, dto.title ?? existing.title, existing.id) : existing.slug;
    const category = dto.category === undefined ? existing.categoryId : (await this.resolveCategory(dto.category))?.id ?? null;
    const body = dto.body ?? existing.body;
    const publishedAt = resolvePublishedAt(nextStatus, dto.publishAt, existing.publishedAt);

    const patch: Partial<BlogPostRow> = {
      slug,
      title: dto.title?.trim() ?? existing.title,
      body,
      status: nextStatus,
      publishedAt,
      categoryId: category,
      readingMinutes: readingMinutes(body),
    };
    if (dto.excerpt !== undefined) patch.excerpt = dto.excerpt.trim() || plainExcerpt(body, 170) || null;
    if (dto.coverImage !== undefined) patch.coverImage = safeUrlValue(dto.coverImage, 'post.coverImage');
    if (dto.seoTitle !== undefined) patch.seoTitle = dto.seoTitle.trim() || null;
    if (dto.seoDescription !== undefined) patch.seoDescription = dto.seoDescription.trim() || null;
    if (dto.canonicalUrl !== undefined) patch.canonicalUrl = safeUrlValue(dto.canonicalUrl, 'post.canonicalUrl');
    if (dto.authorId) patch.authorId = dto.authorId;

    const before = auditShape(existing);
    const updated = await this.db.content.updatePost(existing.id, patch);
    if (!updated) throw new AppError('post.not_found', 'the post disappeared mid-update', 404);
    if (dto.tags) await this.db.content.setPostTags(existing.id, dto.tags.map((tag) => tag.trim()).filter(Boolean));

    await this.invalidatePosts(existing.slug, slug);
    this.audit.recordChange(meta, {
      action: 'blog.post.update',
      targetKind: 'blog_post',
      targetId: existing.id,
      before,
      after: { ...auditShape(updated), tags: dto.tags ?? null },
    });
    return this.buildPost((await this.db.content.findPostBySlug(slug)) ?? updated, { related: false, preview: !isLive(updated) });
  }

  /** Publish now. Separate from `updatePost` so the admin UI has one obvious button. */
  async publishPost(meta: RequestMeta, actor: RequestUser, ref: string): Promise<PostView> {
    assertPermission(actor, 'blog.publish');
    const existing = await this.findPostByRef(ref);
    const publishedAt = existing.publishedAt ?? new Date();
    const updated = await this.db.content.updatePost(existing.id, { status: ContentStatus.published, publishedAt });
    if (!updated) throw new AppError('post.not_found', 'the post disappeared mid-publish', 404);

    await this.invalidatePosts(existing.slug);
    this.audit.recordChange(meta, {
      action: 'blog.post.publish',
      targetKind: 'blog_post',
      targetId: existing.id,
      before: { status: existing.status, publishedAt: iso(existing.publishedAt) },
      after: { status: ContentStatus.published, publishedAt: iso(publishedAt) },
    });
    this.logger.log(`post published: ${existing.slug} by ${actor.username}`);
    return this.buildPost((await this.db.content.findPostBySlug(existing.slug)) ?? updated, { related: false, preview: false });
  }

  /** Soft delete by default: an archive keeps the URL redirectable and the audit intact. */
  async deletePost(meta: RequestMeta, actor: RequestUser, ref: string, hard = false): Promise<{ deleted: boolean; hard: boolean }> {
    assertPermission(actor, 'blog.delete');
    const existing = await this.findPostByRef(ref);
    const deleted = await this.db.content.deletePost(existing.id, { hard });

    await this.invalidatePosts(existing.slug);
    this.audit.record(meta, {
      action: hard ? 'blog.post.delete_hard' : 'blog.post.delete',
      targetKind: 'blog_post',
      targetId: existing.id,
      before: auditShape(existing),
    });
    this.logger.warn(`post ${hard ? 'hard-deleted' : 'archived'}: ${existing.slug} by ${actor.username}`);
    return { deleted, hard };
  }

  /**
   * Bring an archived post back. It returns as `archived`, not `published`: restoring
   * undoes the delete, and going live again stays an explicit act that needs
   * `blog.publish`. Two permissions, two intents, no accident where undoing a delete
   * silently re-publishes something an editor took down on purpose.
   */
  async restorePost(meta: RequestMeta, actor: RequestUser, ref: string): Promise<PostView> {
    assertPermission(actor, 'blog.update');
    const existing = await this.findPostByRef(ref);
    if (!existing.deletedAt) throw new AppError('post.not_archived', 'this post is not archived', 409);
    const restored = await this.db.content.restorePost(existing.id);
    if (!restored) throw new AppError('post.not_found', 'the post disappeared mid-restore', 404);

    await this.invalidatePosts(restored.slug);
    this.audit.record(meta, {
      action: 'blog.post.restore',
      targetKind: 'blog_post',
      targetId: restored.id,
      before: { deletedAt: iso(existing.deletedAt), status: existing.status },
      after: { deletedAt: null, status: restored.status },
    });
    this.logger.log(`post restored: ${restored.slug} by ${actor.username}`);
    return this.buildPost(restored, { related: false, preview: true });
  }

  async restorePage(meta: RequestMeta, id: string): Promise<PageView> {
    const row = await this.findPageById(id);
    if (!row.deletedAt) throw new AppError('page.not_archived', 'this page is not archived', 409);
    const restored = await this.db.content.restorePage(row.id);
    if (!restored) throw new AppError('page.not_found', 'the page disappeared mid-restore', 404);

    await this.invalidatePages(restored.slug);
    this.audit.record(meta, {
      action: 'page.restore',
      targetKind: 'page',
      targetId: restored.id,
      before: { deletedAt: iso(row.deletedAt) },
      after: { deletedAt: null },
    });
    return this.buildPage(restored, true);
  }

  // ─────────────────────── admin: blog categories ─────────────────────────

  async adminBlogCategories(): Promise<{ items: BlogCategoryView[]; tree: BlogCategoryView[] }> {
    // Same shape as the public list, minus the cache: an editor must see the row they
    // just wrote, not a copy that expires in ten minutes.
    const rows = await this.db.content.listBlogCategories();
    const items = rows.map((row) => this.categoryView(row));
    const byParent = new Map<string | null, BlogCategoryView[]>();
    for (const item of items) {
      const bucket = byParent.get(item.parentId) ?? [];
      bucket.push(item);
      byParent.set(item.parentId, bucket);
    }
    const attach = (nodes: BlogCategoryView[]): BlogCategoryView[] =>
      nodes.map((node) => ({ ...node, children: attach(byParent.get(node.id) ?? []) }));
    return { items, tree: attach(byParent.get(null) ?? []) };
  }

  async upsertBlogCategory(meta: RequestMeta, actor: RequestUser, dto: UpsertBlogCategoryDto): Promise<BlogCategoryView> {
    const name = dto.name.trim();
    const existing = dto.id ? await this.findBlogCategory(dto.id) : null;
    // The route is guarded by blog.create (it is a create endpoint); carrying an id
    // turns it into an update, which is a different right and must be checked here
    // where the payload — not just the route — is visible.
    if (existing) assertPermission(actor, 'blog.update');
    const slug = await this.resolveCategorySlug(dto.slug, name, existing?.id ?? null);

    if (dto.parentId && dto.parentId === existing?.id) {
      throw new AppError('blog_category.self_parent', 'a category cannot be its own parent', 400);
    }

    const row = existing
      ? await this.db.content.updateBlogCategory(existing.id, {
          name,
          slug,
          description: dto.description?.trim() || null,
          parentId: dto.parentId === undefined ? existing.parentId : dto.parentId || null,
          sortOrder: dto.sortOrder ?? existing.sortOrder,
        })
      : await this.db.content.createBlogCategory({
          name,
          slug,
          description: dto.description?.trim() || null,
          parentId: dto.parentId || null,
          sortOrder: dto.sortOrder ?? 0,
        });
    if (!row) throw new AppError('blog_category.not_found', 'the category disappeared mid-write', 404);

    await this.redis.del(CACHE.key.blogCategories());
    this.audit.recordChange(meta, {
      action: existing ? 'blog.category.update' : 'blog.category.create',
      targetKind: 'blog_category',
      targetId: row.id,
      before: existing ? auditShape(existing) : {},
      after: auditShape(row),
    });
    return this.categoryView(row);
  }

  async deleteBlogCategory(meta: RequestMeta, id: string): Promise<{ deleted: boolean }> {
    const existing = await this.findBlogCategory(id);
    if (existing.postsCount > 0) {
      // Refusing is the point: deleting a category with posts would either orphan them
      // or silently refile them, and neither is what "delete" means to an editor.
      throw new AppError('blog_category.not_empty', `move or delete its ${existing.postsCount} post(s) first`, 409);
    }
    const deleted = await this.db.content.deleteBlogCategory(existing.id);
    await this.redis.del(CACHE.key.blogCategories());
    this.audit.record(meta, { action: 'blog.category.delete', targetKind: 'blog_category', targetId: existing.id, before: auditShape(existing) });
    return { deleted };
  }

  // ───────────────────────────── admin: pages ─────────────────────────────

  async adminPages(query: AdminPageListQueryDto): Promise<{ items: PageView[]; total: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(query.perPage ?? 25)));
    const status = query.status?.trim() && query.status !== 'any' ? query.status : 'any';
    const result = await this.db.content.listPages({
      status,
      includeDeleted: status === 'any',
      page: { page, perPage, offset: (page - 1) * perPage },
    });
    return { items: result.items.map((row) => this.buildPage(row, !isPageLive(row))), total: result.total };
  }

  async adminPage(actor: RequestUser, slug: string): Promise<PageView> {
    assertPermission(actor, 'pages.manage');
    const row = await this.db.content.findPageBySlug(slug);
    if (!row) throw new AppError('page.not_found', `no page with the slug "${slug}"`, 404);
    return this.buildPage(row, !isPageLive(row));
  }

  async upsertPage(meta: RequestMeta, dto: UpsertPageDto): Promise<PageView> {
    const existing = dto.id ? await this.findPageById(dto.id) : null;
    const title = dto.title.trim();
    const status = dto.status ?? existing?.status ?? ContentStatus.draft;
    const slug = await this.resolvePageSlug(dto.slug, title, existing?.id ?? null);
    const blocks = dto.blocks ? normalizeBlocks(dto.blocks, this.logger) : (existing?.blocks as PageBlock[] | undefined) ?? [];

    const payload = {
      slug,
      title,
      titleEn: dto.titleEn?.trim() || null,
      body: dto.body ?? null,
      blocks,
      template: dto.template?.trim() || existing?.template || 'default',
      status,
      isIndexed: dto.isIndexed ?? existing?.isIndexed ?? true,
      seoTitle: dto.seoTitle?.trim() || null,
      seoDescription: dto.seoDescription?.trim() || null,
      canonicalUrl: safeUrlValue(dto.canonicalUrl, 'page.canonicalUrl'),
      sortOrder: dto.sortOrder ?? existing?.sortOrder ?? 0,
    };

    const row = existing ? await this.db.content.updatePage(existing.id, payload) : await this.db.content.createPage(payload);
    if (!row) throw new AppError('page.not_found', 'the page disappeared mid-write', 404);

    await this.invalidatePages(existing?.slug, row.slug);
    this.audit.recordChange(meta, {
      action: existing ? 'page.update' : 'page.create',
      targetKind: 'page',
      targetId: row.id,
      before: existing ? auditShape(existing) : {},
      after: { ...auditShape(row), blocks: `${blocks.length} block(s)` },
    });
    this.logger.log(`page ${existing ? 'updated' : 'created'}: /${row.slug} (${status})`);
    return this.buildPage(row, !isPageLive(row));
  }

  async deletePage(meta: RequestMeta, id: string, hard = false): Promise<{ deleted: boolean; hard: boolean }> {
    const row = await this.findPageById(id);
    const deleted = await this.db.content.deletePage(row.id, { hard });
    await this.invalidatePages(row.slug);
    this.audit.record(meta, {
      action: hard ? 'page.delete_hard' : 'page.delete',
      targetKind: 'page',
      targetId: row.id,
      before: auditShape(row),
    });
    return { deleted, hard };
  }

  // ───────────────────────────── internals ────────────────────────────────

  /**
   * One view per visitor per hour. The play-session cookie identifies an anonymous
   * visitor as reliably as anything we have without fingerprinting; the IP is the
   * fallback for a first request with no cookie yet.
   */
  /** Returns true when *this* request is the one that counted the view. */
  private async countView(row: BlogPostRow, meta: RequestMeta): Promise<boolean> {
    const visitor = meta.actorId ?? meta.playSessionId ?? meta.ip ?? 'unknown';
    const { count } = await this.redis.increment(CACHE.key.postView(row.id, visitor), 3600);
    if (count !== 1) return false;
    await this.db.content.incrementPostViews(row.id);
    return true;
  }

  private async buildPost(row: BlogPostRow, options: { related: boolean; preview: boolean }): Promise<PostView> {
    const card = this.postCard(row);
    const live = isLive(row);
    const indexed = live && !options.preview;
    const baseUrl = this.config.APP_URL;
    const url = absoluteUrl(card.url, baseUrl) ?? card.url;

    const jsonLd: Record<string, unknown>[] = [
      blogPostingJsonLd(
        {
          slug: row.slug,
          title: row.title,
          excerpt: row.excerpt,
          body: row.body,
          coverImage: row.coverImage,
          publishedAt: iso(row.publishedAt),
          updatedAt: iso(row.updatedAt),
          readingMinutes: row.readingMinutes,
          author: {
            name: row.author?.displayName || row.author?.username || 'Voltade',
            url: row.author ? absoluteUrl(`/users/${row.author.username}`, baseUrl) ?? undefined : undefined,
          },
          categoryName: row.category?.name ?? null,
        },
        baseUrl,
      ),
      breadcrumbJsonLd(
        [
          { name: 'المدونة', path: '/blog' },
          ...(row.category ? [{ name: row.category.name, path: categoryPath(row.category.slug) }] : []),
          { name: row.title, path: postPath(row.slug) },
        ],
        baseUrl,
      ),
    ];

    return {
      ...card,
      body: row.body,
      tags: (row.tags ?? []).map(({ slug, name }) => ({ slug, name })),
      seo: {
        title: row.seoTitle ?? row.title,
        description: row.seoDescription ?? row.excerpt ?? plainExcerpt(row.body, 160),
        canonical: row.canonicalUrl ?? url,
        robots: indexed ? 'index, follow, max-image-preview:large' : 'noindex, nofollow',
      },
      jsonLd,
      related: options.related ? (await this.db.content.relatedPosts(row.id, 4)).map((r) => this.postCard(r)) : [],
      preview: options.preview,
    };
  }

  private postCard(row: BlogPostRow): PostCard {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      coverImage: row.coverImage,
      url: postPath(row.slug),
      author: row.author ? { username: row.author.username, displayName: row.author.displayName, avatarUrl: row.author.avatarUrl } : null,
      category: row.category ? { slug: row.category.slug, name: row.category.name } : null,
      status: row.status,
      live: isLive(row),
      publishedAt: iso(row.publishedAt),
      updatedAt: iso(row.updatedAt) ?? '',
      readingMinutes: row.readingMinutes,
      views: row.views,
      deletedAt: iso(row.deletedAt),
    };
  }

  private buildPage(row: PageRow, preview: boolean): PageView {
    const blocks = Array.isArray(row.blocks) ? (row.blocks as PageBlock[]) : [];
    const baseUrl = this.config.APP_URL;
    const url = absoluteUrl(pagePath(row.slug), baseUrl) ?? pagePath(row.slug);
    const live = isPageLive(row);

    // An FAQ block is structured data waiting to happen: emitting it as FAQPage is the
    // difference between a plain blue link and a rich result with the answers under it.
    const faqItems = blocks
      .filter((block) => block?.type === 'faq')
      .flatMap((block) => (Array.isArray((block.props as { items?: unknown })?.items) ? ((block.props as { items: { q: unknown; a: unknown }[] }).items) : []))
      .filter((item) => typeof item?.q === 'string' && typeof item?.a === 'string')
      .map((item) => ({ q: String(item.q), a: String(item.a) }));

    const jsonLd: Record<string, unknown>[] = [
      breadcrumbJsonLd([{ name: 'الرئيسية', path: '/' }, { name: row.title, path: pagePath(row.slug) }], baseUrl),
    ];
    if (faqItems.length) jsonLd.push(faqJsonLd(faqItems));

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      titleEn: row.titleEn,
      url: pagePath(row.slug),
      template: row.template,
      status: row.status,
      live,
      body: row.body,
      blocks,
      isIndexed: row.isIndexed,
      sortOrder: row.sortOrder,
      updatedAt: iso(row.updatedAt) ?? '',
      deletedAt: iso(row.deletedAt),
      seo: {
        title: row.seoTitle ?? row.title,
        description: row.seoDescription ?? (row.body ? plainExcerpt(row.body, 160) : null),
        canonical: row.canonicalUrl ?? url,
        robots: live && row.isIndexed && !preview ? 'index, follow, max-image-preview:large' : 'noindex, nofollow',
      },
      jsonLd,
      preview,
    };
  }

  private categoryView(row: BlogCategoryRow): BlogCategoryView {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      url: categoryPath(row.slug),
      parentId: row.parentId,
      postsCount: row.postsCount,
      sortOrder: row.sortOrder,
      children: [],
    };
  }

  /**
   * A post is addressed by slug *or* id. The admin UI holds ids, and a slug can be
   * renamed while a form is open — so an update sent to the old slug must still find
   * the row instead of 404ing on a rename the same editor just made.
   */
  private async findPostByRef(ref: string): Promise<BlogPostRow> {
    const value = String(ref ?? '').trim();
    if (!value) throw new AppError('post.not_found', 'no post reference given', 404);
    // Archived rows are reachable by id only: the public slug lookup keeps refusing
    // them, which is what makes a soft delete safe, while the admin surface can still
    // open, restore or hard-delete one.
    const byId = await this.db.content.findPostById(value, { includeDeleted: true });
    if (byId) return byId;
    const bySlug = await this.db.content.findPostBySlug(value);
    if (bySlug) return bySlug;
    throw new AppError('post.not_found', `no post matching "${value}"`, 404);
  }

  private async findPageById(id: string): Promise<PageRow> {
    const row = await this.db.content.findPageById(id, { includeDeleted: true });
    if (!row) throw new AppError('page.not_found', `no page with the id "${id}"`, 404);
    return row;
  }

  private async findBlogCategory(id: string): Promise<BlogCategoryRow> {
    const rows = await this.db.content.listBlogCategories();
    const hit = rows.find((row) => row.id === id);
    if (!hit) throw new AppError('blog_category.not_found', `no blog category with the id "${id}"`, 404);
    return hit;
  }

  private async resolveCategory(slugOrUndefined: string | undefined | null): Promise<BlogCategoryRow | null> {
    const slug = slugOrUndefined?.trim();
    if (!slug) return null;
    const rows = await this.db.content.listBlogCategories();
    const hit = rows.find((row) => row.slug === slug);
    // Refusing beats auto-creating: a typo in a category field would otherwise spawn a
    // permanent empty category that only shows up in the sitemap.
    if (!hit) throw new AppError('blog_category.not_found', `unknown blog category "${slug}"`, 400);
    return hit;
  }

  private async resolvePostSlug(explicit: string | undefined, title: string, selfId: string | null): Promise<string> {
    const taken = async (candidate: string): Promise<boolean> => {
      const row = await this.db.content.findPostBySlug(candidate);
      return row !== null && row.id !== selfId;
    };
    if (explicit?.trim()) {
      const slug = explicit.trim();
      if (await taken(slug)) throw new AppError('post.slug_taken', `another post already uses "/blog/${slug}"`, 409);
      return slug;
    }
    return uniqueSlug(title, taken);
  }

  private async resolveCategorySlug(explicit: string | undefined, name: string, selfId: string | null): Promise<string> {
    const rows = await this.db.content.listBlogCategories();
    const taken = async (candidate: string): Promise<boolean> => rows.some((row) => row.slug === candidate && row.id !== selfId);
    if (explicit?.trim()) {
      const slug = explicit.trim();
      if (await taken(slug)) throw new AppError('blog_category.slug_taken', `another category already uses "${slug}"`, 409);
      return slug;
    }
    return uniqueSlug(name, taken);
  }

  private async resolvePageSlug(explicit: string | undefined, title: string, selfId: string | null): Promise<string> {
    const taken = async (candidate: string): Promise<boolean> => {
      const row = await this.db.content.findPageBySlug(candidate);
      return row !== null && row.id !== selfId;
    };
    const guard = (slug: string): string => {
      if (RESERVED_PAGE_SLUGS.has(slug)) {
        throw new AppError('page.slug_reserved', `"${slug}" is an application route — a page there could never be reached`, 409);
      }
      return slug;
    };
    if (explicit?.trim()) {
      const slug = guard(explicit.trim());
      if (await taken(slug)) throw new AppError('page.slug_taken', `another page already uses "/${slug}"`, 409);
      return slug;
    }
    const base = slugify(title);
    if (RESERVED_PAGE_SLUGS.has(base)) {
      // A page titled "Games" cannot live at /games; /page-games is unambiguous.
      return uniqueSlug(`page-${base}`, taken);
    }
    return uniqueSlug(base, taken);
  }

  /** Drop the single-post caches and bump the list namespace so listings refresh. */
  private async invalidatePosts(...slugs: (string | undefined)[]): Promise<void> {
    const keys = [...new Set(slugs.filter(Boolean) as string[])].map((slug) => CACHE.key.post(slug));
    await this.redis.del(...keys);
    await this.redis.increment(CACHE.key.postsVersion(), 60 * 60 * 24 * 30);
    await this.redis.del(CACHE.key.blogCategories());
  }

  private async invalidatePages(...slugs: (string | undefined)[]): Promise<void> {
    const keys = [...new Set(slugs.filter(Boolean) as string[])].map((slug) => CACHE.key.page(slug));
    await this.redis.del(...keys, CACHE.key.pages('live'), CACHE.key.pages('all'));
  }
}

// ───────────────────────────── module-local helpers ─────────────────────────

function hasPermission(user: RequestUser | null | undefined, permission: string): boolean {
  return Boolean(user?.permissions?.includes(permission));
}

function assertPermission(user: RequestUser | null | undefined, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new AppError('auth.missing_permission', `this needs the "${permission}" permission`, 403);
  }
}

/** Publishing is its own right: `blog.update` alone must not be able to push live. */
function assertPublishAllowed(user: RequestUser | null | undefined, status: string): void {
  const visible = status === ContentStatus.published || status === ContentStatus.scheduled;
  if (visible && !hasPermission(user, 'blog.publish')) {
    throw new AppError('auth.missing_permission', 'only an editor with "blog.publish" can publish or schedule a post', 403);
  }
}

/**
 * publishedAt is written once and never moved by a later edit.
 *
 * · publishing now  → the current time (or the editor's chosen publishAt)
 * · scheduling      → the chosen time, which must be in the future
 * · anything else   → keep whatever is already there, so un-publishing and
 *   re-publishing restores the original date instead of inventing a new one
 */
function resolvePublishedAt(status: string, publishAt: string | undefined, current: Date | null): Date | null {
  const chosen = publishAt ? new Date(publishAt) : null;
  if (chosen && Number.isNaN(chosen.getTime())) throw new AppError('post.invalid_publish_at', 'publishAt is not a valid date', 400);

  if (status === ContentStatus.scheduled) {
    if (!chosen) throw new AppError('post.publish_at_required', 'a scheduled post needs publishAt', 400);
    if (chosen.getTime() <= Date.now()) throw new AppError('post.publish_at_past', 'publishAt must be in the future — publish it instead', 400);
    return chosen;
  }
  if (status === ContentStatus.published) return chosen ?? current ?? new Date();
  return current ?? chosen;
}

/**
 * A URL field is either safe or the request is wrong — never silently dropped.
 *
 * `undefined` (the field was absent from this request) passes through as `undefined`,
 * because the repository's column mapper skips undefined keys: on a PATCH that is the
 * difference between "leave it alone" and "clear it". An empty string means clear it.
 */
function safeUrlValue(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const safe = safeUrl(text, text.startsWith('/') ? 'a' : 'img', 'href');
  if (!safe) throw new AppError('content.unsafe_url', `${field} is not a URL this site will store`, 400);
  return safe;
}

/**
 * Blocks are normalised, not merely type-checked: the renderer trusts what is stored.
 *
 * · every block gets a stable id (the editor patches and reorders by id)
 * · unknown props are kept — a renderer ignores what it does not know, and dropping
 *   them would destroy data the moment a block type gains a field
 * · `html` is sanitised, and any attempt at a script/iframe/handler is logged with the
 *   page it came from: sanitising silently would hide an editor who is being phished
 * · any url/href/src/link prop goes through safeUrl, so `javascript:` cannot ride in
 *   through a block prop just because the top-level fields were checked
 */
function normalizeBlocks(blocks: PageBlockDto[], logger: Logger): PageBlock[] {
  return blocks.map((block, index) => {
    const props: Record<string, unknown> = { ...(block.props ?? {}) };

    if (block.type === 'html') {
      const raw = String(props.html ?? '');
      if (raw.length > MAX_HTML_LENGTH) throw new AppError('page.block_too_large', `an html block must be under ${MAX_HTML_LENGTH} characters`, 413);
      const findings = findUnsafeHtml(raw);
      if (findings.length) {
        logger.warn(`html block sanitised — removed: ${findings.map((finding) => finding.reason).join(', ')}`);
      }
      props.html = sanitizeHtml(raw);
    }

    if (block.type === 'faq') {
      const items = Array.isArray(props.items) ? (props.items as { q?: unknown; a?: unknown }[]) : [];
      if (items.length > MAX_FAQ_ITEMS) throw new AppError('page.block_too_large', `an faq block holds at most ${MAX_FAQ_ITEMS} items`, 400);
      props.items = items
        .filter((item) => typeof item?.q === 'string' && typeof item?.a === 'string')
        .map((item) => ({ q: String(item.q).slice(0, 300), a: String(item.a).slice(0, 2000) }));
    }

    for (const key of ['url', 'href', 'src', 'link', 'image', 'coverImage']) {
      const value = props[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const safe = safeUrl(value.trim(), key === 'src' || key === 'image' ? 'img' : 'a', key === 'src' ? 'src' : 'href');
      if (!safe) throw new AppError('content.unsafe_url', `block "${block.type}" prop "${key}" is not a URL this site will store`, 400);
      props[key] = safe;
    }

    return { id: block.id?.trim() || `b${index + 1}`, type: block.type, props };
  });
}

function isPageLive(row: PageRow): boolean {
  return row.status === ContentStatus.published;
}

/** The subset of a row worth diffing in the activity log (no bodies, no blocks). */
function auditShape(row: BlogPostRow | PageRow | BlogCategoryRow): Record<string, unknown> {
  const base: Record<string, unknown> = {
    slug: 'slug' in row ? row.slug : undefined,
    title: 'title' in row ? row.title : undefined,
    status: 'status' in row ? row.status : undefined,
  };
  if ('publishedAt' in row) base.publishedAt = iso(row.publishedAt);
  if ('parentId' in row) base.parentId = row.parentId;
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}
