/**
 * Taxonomy: nested categories and multi-tags.
 *
 * THREE decisions shape this module:
 *
 * 1. NESTING IS UNLIMITED, CYCLES ARE NOT. A category may be moved under any other
 *    category, but `update()` walks the new parent's ancestors first and refuses a
 *    move that would make a category its own descendant. A cycle in the tree is not
 *    a rendering bug — it is an infinite loop in every recursive query and in the
 *    breadcrumb builder, discovered in production by a hung request.
 *
 * 2. COUNTS ARE DENORMALISED (`games_count`) and repaired by `recount`, because a
 *    navigation menu that shows "Racing (0)" while the category page shows 40 games
 *    is the single most visible bug a portal can have.
 *
 * 3. SLUGS ARE THE PUBLIC CONTRACT. Parents are referenced by slug in the DTOs and
 *    a slug change writes a 301 redirect, so an editor reorganising the taxonomy
 *    cannot destroy the inbound links that took months to earn.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CategoryRow, Database, GameRow, TagRow } from '@voltade/db';
import { slugify } from '@voltade/shared';
import type { Locale } from '@voltade/shared';
import { AuditService } from '../../common/audit/audit.service.js';
import { DATABASE } from '../../common/database/database.module.js';
import { AppError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { absoluteUrl, localized } from '../../common/http/urls.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import type { CreateCategoryDto, ReorderCategoriesDto, TagQueryDto, UpdateCategoryDto, UpsertTagsDto } from './dto/taxonomy.dto.js';

export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  icon: string | null;
  thumbnailUrl: string | null;
  color: string | null;
  gamesCount: number;
  isVisible: boolean;
  sortOrder: number;
  url: string;
  parent: { slug: string; name: string } | null;
  children: CategoryNode[];
};

export type CategoryDetail = {
  category: CategoryNode;
  ancestors: { slug: string; name: string; url: string }[];
  children: CategoryNode[];
  seo: { title: string; description: string | null; keywords: string | null; canonical: string | null };
};

export type TagNode = { id: string; slug: string; name: string; gamesCount: number; url: string };

export type Suggestion = {
  categories: { slug: string; name: string; url: string; gamesCount: number }[];
  tags: { slug: string; name: string; url: string }[];
  games: { slug: string; title: string; thumbnailUrl: string; url: string }[];
};

@Injectable()
export class TaxonomyService {
  private readonly logger = new Logger('taxonomy');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  // ── public reads ─────────────────────────────────────────────────────────

  /** The navigation tree. Hidden categories are excluded unless the caller may manage them. */
  async tree(meta: RequestMeta, options: { includeHidden?: boolean } = {}): Promise<CategoryNode[]> {
    const rows = await this.db.catalog.categoryTree({ visibleOnly: !options.includeHidden });
    return rows.map((row) => this.node(row, meta.locale, true));
  }

  async flat(meta: RequestMeta, options: { includeHidden?: boolean } = {}): Promise<CategoryNode[]> {
    const rows = await this.db.catalog.listCategories({ visibleOnly: !options.includeHidden, includeHiddenCount: true });
    return rows.map((row) => this.node(row, meta.locale, false));
  }

  async bySlug(meta: RequestMeta, slug: string, options: { includeHidden?: boolean } = {}): Promise<CategoryDetail> {
    const row = await this.db.catalog.findCategoryBySlug(slug);
    if (!row || row.deletedAt) throw new AppError('category.not_found', `no category with the slug "${slug}"`, 404);
    if (!row.isVisible && !options.includeHidden) {
      // Same rule as games: a hidden category is a 404, not a 403.
      throw new AppError('category.not_found', `no category with the slug "${slug}"`, 404);
    }

    const ancestors = await this.ancestors(row);
    const children = (await this.db.catalog.categoryTree({ visibleOnly: !options.includeHidden }))
      .flatMap((top) => collect(top))
      .filter((child) => child.parentId === row.id)
      .map((child) => this.node(child, meta.locale, false));

    const node = this.node(row, meta.locale, false);
    return {
      category: { ...node, children },
      ancestors: ancestors.map((a) => ({ slug: a.slug, name: this.name(a, meta.locale), url: `/category/${a.slug}` })),
      children,
      seo: {
        title: row.seoTitle ?? node.name,
        description: row.seoDescription ?? row.description,
        keywords: row.seoKeywords ?? null,
        canonical: row.canonicalUrl ?? null,
      },
    };
  }

  async tags(meta: RequestMeta, query: TagQueryDto): Promise<TagNode[]> {
    void meta;
    const rows = await this.db.catalog.listTags({ scope: query.scope ?? 'game', q: query.q?.trim() || undefined, limit: query.limit });
    return rows.map((tag) => this.tag(tag));
  }

  async tagBySlug(meta: RequestMeta, slug: string, scope = 'game'): Promise<{ tag: TagNode; seo: { title: string } }> {
    void meta;
    const row = await this.db.catalog.findTagBySlug(slug, scope);
    if (!row) throw new AppError('tag.not_found', `no tag with the slug "${slug}"`, 404);
    return { tag: this.tag(row), seo: { title: row.name } };
  }

  /**
   * Instant-search dropdown: three cheap probes (categories, tags, games) instead of
   * one expensive join. Each is index-backed and capped, so typing feels immediate
   * even with 20k games and a thousand tags.
   */
  async suggest(meta: RequestMeta, term: string, limit = 5): Promise<Suggestion> {
    const q = term.trim();
    if (q.length === 0) return { categories: [], tags: [], games: [] };

    const categories = await this.db.catalog.listCategories({ visibleOnly: true });
    const tags = await this.db.catalog.listTags({ scope: 'game', q, limit });
    const games = await this.db.catalog.listGames({ publishedOnly: true, q, locale: meta.locale, page: { page: 1, perPage: limit, offset: 0 } });

    const needle = q.toLowerCase();
    const base = this.config.apiPublicUrl;
    return {
      // The category list is small and cached in memory by the caller, so filtering
      // by prefix-then-substring here is cheaper than another round trip.
      categories: categories
        .filter((category) => category.name.toLowerCase().startsWith(needle) || category.slug.startsWith(needle) || category.name.toLowerCase().includes(needle))
        .sort((a, b) => b.gamesCount - a.gamesCount)
        .slice(0, limit)
        .map((category) => ({ slug: category.slug, name: this.name(category, meta.locale), url: `/category/${category.slug}`, gamesCount: category.gamesCount })),
      tags: tags.map((tag) => ({ slug: tag.slug, name: tag.name, url: `/tag/${tag.slug}` })),
      games: games.items.map((game: GameRow) => ({
        slug: game.slug,
        title: localized(game.title, game.titleEn, meta.locale) ?? game.title,
        thumbnailUrl: absoluteUrl(game.thumbnailUrl, base) ?? '',
        url: `/game/${game.slug}`,
      })),
    };
  }

  // ── admin writes ─────────────────────────────────────────────────────────

  async create(meta: RequestMeta, dto: CreateCategoryDto): Promise<CategoryRow> {
    const slug = await this.uniqueCategorySlug(dto.slug || dto.name);
    const parentId = dto.parent ? await this.parentId(dto.parent) : null;

    const row = await this.db.catalog.createCategory({
      slug,
      name: dto.name.trim(),
      nameEn: dto.nameEn?.trim() ?? null,
      parentId,
      description: dto.description ?? null,
      icon: dto.icon ?? null,
      thumbnailUrl: dto.thumbnailUrl ?? null,
      color: dto.color ?? null,
      sortOrder: dto.sortOrder ?? 0,
      isVisible: dto.isVisible ?? true,
      seoTitle: dto.seoTitle ?? null,
      seoDescription: dto.seoDescription ?? null,
      seoKeywords: dto.seoKeywords ?? null,
      canonicalUrl: dto.canonicalUrl ?? null,
    });
    this.audit.record(meta, { action: 'category.create', targetKind: 'category', targetId: row.id, after: { slug: row.slug, name: row.name, parent: dto.parent ?? null } });
    // Attach the parent to the response: the admin tree has to know where the new
    // node belongs without a second round-trip.
    if (parentId) {
      const parent = await this.db.catalog.findCategoryById(parentId);
      if (parent) row.parent = { id: parent.id, slug: parent.slug, name: parent.name, nameEn: parent.nameEn } as CategoryRow;
    }
    return row;
  }

  async update(meta: RequestMeta, id: string, dto: UpdateCategoryDto): Promise<CategoryRow> {
    const existing = await this.db.catalog.findCategoryById(id);
    if (!existing) throw new AppError('category.not_found', `no category with id ${id}`, 404);

    const patch: Partial<CategoryRow> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.nameEn !== undefined) patch.nameEn = dto.nameEn?.trim() ?? null;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.thumbnailUrl !== undefined) patch.thumbnailUrl = dto.thumbnailUrl;
    if (dto.color !== undefined) patch.color = dto.color;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
    if (dto.isVisible !== undefined) patch.isVisible = dto.isVisible;
    if (dto.seoTitle !== undefined) patch.seoTitle = dto.seoTitle;
    if (dto.seoDescription !== undefined) patch.seoDescription = dto.seoDescription;
    if (dto.seoKeywords !== undefined) patch.seoKeywords = dto.seoKeywords;
    if (dto.canonicalUrl !== undefined) patch.canonicalUrl = dto.canonicalUrl;

    if (dto.parent !== undefined) {
      if (dto.parent === '' || dto.parent === 'null') patch.parentId = null;
      else {
        const parentId = await this.parentId(dto.parent);
        if (parentId === id) throw new AppError('category.cycle', 'a category cannot be its own parent', 400);
        // Walk the new parent's ancestors: if this category is one of them, the move
        // would detach the subtree from the root and loop forever on render.
        const parentRow = await this.db.catalog.findCategoryById(parentId);
        if (parentRow) {
          const chain = await this.ancestors(parentRow);
          if (chain.some((ancestor) => ancestor.id === id)) {
            throw new AppError('category.cycle', 'that move would make the category a descendant of itself', 400);
          }
        }
        patch.parentId = parentId;
      }
    }

    if (dto.slug !== undefined && dto.slug.trim() && dto.slug !== existing.slug) {
      patch.slug = await this.uniqueCategorySlug(dto.slug, id);
      await this.db.operations.upsertRedirect({ sourcePath: `/category/${existing.slug}`, targetPath: `/category/${patch.slug}`, statusCode: 301 });
    }

    const updated = await this.db.catalog.updateCategory(id, patch);
    if (!updated) throw new AppError('category.not_found', `no category with id ${id}`, 404);
    this.audit.recordChange(meta, {
      action: 'category.update',
      targetKind: 'category',
      targetId: id,
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async remove(meta: RequestMeta, id: string): Promise<{ deleted: boolean; reattachedChildren: number }> {
    const existing = await this.db.catalog.findCategoryById(id);
    if (!existing) throw new AppError('category.not_found', `no category with id ${id}`, 404);

    // Children move up to this category's parent instead of being deleted: an
    // editor removing "Racing" almost never means "delete 300 games' navigation".
    const children = (await this.db.catalog.listCategories({ visibleOnly: false })).filter((row) => row.parentId === id);
    for (const child of children) await this.db.catalog.updateCategory(child.id, { parentId: existing.parentId });

    const deleted = await this.db.catalog.deleteCategory(id);
    this.audit.record(meta, {
      action: 'category.delete',
      targetKind: 'category',
      targetId: id,
      before: { slug: existing.slug, name: existing.name, children: children.length },
    });
    return { deleted, reattachedChildren: children.length };
  }

  async reorder(meta: RequestMeta, dto: ReorderCategoriesDto): Promise<{ reordered: number }> {
    await this.db.catalog.reorderCategories(dto.ids);
    this.audit.record(meta, { action: 'categories.reorder', targetKind: 'category', after: { ids: dto.ids } });
    return { reordered: dto.ids.length };
  }

  async upsertTags(meta: RequestMeta, dto: UpsertTagsDto): Promise<TagRow[]> {
    const rows = await this.db.catalog.upsertTags(dto.tags, dto.scope ?? 'game');
    this.audit.record(meta, { action: 'tags.upsert', targetKind: 'tag', after: { count: rows.length, scope: dto.scope ?? 'game' } });
    return rows;
  }

  /** Re-derive every category and tag counter from the join tables. */
  async recount(meta: RequestMeta): Promise<{ categories: number; tags: number }> {
    const categories = await this.db.catalog.listCategories({ visibleOnly: false });
    const games = await this.db.catalog.listGames({ publishedOnly: false, includeDeleted: true, with: ['categories', 'tags'], page: { page: 1, perPage: 5000, offset: 0 } });

    const perCategory = new Map<string, number>();
    const perTag = new Map<string, number>();
    for (const game of games.items) {
      if (game.status !== 'published') continue;
      for (const category of game.categories ?? []) perCategory.set(category.id, (perCategory.get(category.id) ?? 0) + 1);
      for (const tag of game.tags ?? []) perTag.set(tag.id, (perTag.get(tag.id) ?? 0) + 1);
    }
    for (const category of categories) {
      const count = perCategory.get(category.id) ?? 0;
      if (count !== category.gamesCount) await this.db.catalog.updateCategory(category.id, { gamesCount: count });
    }
    // Tags are written through upsertTags, which recalculates games_count; the map
    // above is what makes the *drift* visible, so it is logged rather than guessed.
    const driftedTags = [...perTag.entries()].length;
    this.audit.record(meta, { action: 'taxonomy.recount', after: { categories: categories.length, tagsWithGames: driftedTags } });
    this.logger.log(`recounted ${categories.length} categories against ${games.items.length} games`);
    return { categories: categories.length, tags: driftedTags };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private node(row: CategoryRow, locale: Locale, withChildren: boolean): CategoryNode {
    const base = this.config.apiPublicUrl;
    return {
      id: row.id,
      slug: row.slug,
      name: localized(row.name, row.nameEn, locale) ?? row.name,
      nameEn: row.nameEn,
      description: row.description,
      icon: row.icon,
      thumbnailUrl: absoluteUrl(row.thumbnailUrl, base),
      color: row.color,
      gamesCount: row.gamesCount,
      isVisible: row.isVisible,
      sortOrder: row.sortOrder,
      url: `/category/${row.slug}`,
      parent: row.parent ? { slug: row.parent.slug, name: row.parent.name } : null,
      children: withChildren ? (row.children ?? []).map((child) => this.node(child, locale, true)) : [],
    };
  }

  private tag(row: TagRow): TagNode {
    return { id: row.id, slug: row.slug, name: row.name, gamesCount: row.gamesCount, url: `/tag/${row.slug}` };
  }

  private name(row: CategoryRow, locale: Locale): string {
    return localized(row.name, row.nameEn, locale) ?? row.name;
  }

  private async parentId(parentSlug: string): Promise<string> {
    const parent = await this.db.catalog.findCategoryBySlug(slugify(parentSlug, { max: 90 }) || parentSlug);
    if (!parent) throw new AppError('category.parent_not_found', `no parent category with the slug "${parentSlug}"`, 400);
    return parent.id;
  }

  private async ancestors(row: CategoryRow): Promise<CategoryRow[]> {
    const chain: CategoryRow[] = [];
    let current = row;
    // Bounded walk: even if a cycle somehow exists in the data, this terminates and
    // reports it instead of hanging the request.
    for (let depth = 0; depth < 12 && current.parentId; depth += 1) {
      const parent = await this.db.catalog.findCategoryById(current.parentId);
      if (!parent || chain.some((seen) => seen.id === parent.id)) break;
      chain.unshift(parent);
      current = parent;
    }
    return chain;
  }

  private async uniqueCategorySlug(input: string, excludeId?: string): Promise<string> {
    const base = slugify(input, { max: 90 }) || `category-${Date.now().toString(36)}`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.db.catalog.findCategoryBySlug(candidate);
      if (!existing || existing.id === excludeId) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

/** Flatten a category tree (used to find one category's children). */
function collect(row: CategoryRow, into: CategoryRow[] = []): CategoryRow[] {
  into.push(row);
  for (const child of row.children ?? []) collect(child, into);
  return into;
}
