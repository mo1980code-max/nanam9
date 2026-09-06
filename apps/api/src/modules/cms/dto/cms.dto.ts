/**
 * CMS DTOs: the blog (posts + categories) and the page builder.
 *
 * THE SHAPE DECISIONS, AND WHY:
 *
 * · Post bodies are Markdown, never HTML. Rendering happens in the web app, so a
 *   compromised editor account cannot plant a `<script>` that every visitor runs.
 *   The one place raw HTML is accepted is an `html` page block, and that is
 *   sanitised server-side (see CmsService).
 *
 * · `slug` is optional on write. Absent, it is derived from the title — which
 *   matters most for Arabic titles, where a hand-typed slug is the difference
 *   between `/blog/أفضل-10` and `/blog/best-10-games`.
 *
 * · `publishAt` exists so scheduling is data, not a cron job. A post saved with
 *   status=scheduled and a future publishAt becomes visible the moment that
 *   instant passes, because the read query evaluates it — there is no worker that
 *   can be down, late or silently skipped.
 *
 * · Blocks are a validated list, not a free JSON blob. `type` must be one of
 *   PAGE_BLOCK_TYPES from shared: that list is the contract between this API and
 *   the web renderer, and a type the renderer has never seen would render as a
 *   hole in a published page.
 */

import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ContentStatus, PAGE_BLOCK_TYPES, type PageBlockType } from '@voltade/shared';
import { AdminPaginationQuery, PaginationQuery } from '../../../common/dto/pagination.dto.js';

const STATUSES = Object.values(ContentStatus);
/** The admin list can also ask for everything at once. */
const STATUS_FILTERS = [...STATUSES, 'any'];
const SLUG_RE = /^[a-z0-9\u0600-\u06FF]+(?:-[a-z0-9\u0600-\u06FF]+)*$/;

/**
 * Row ids are 24-character base62 strings (see newId() in packages/db), NOT UUIDs.
 * Validating them as UUIDs would reject every id the API itself handed out — a client
 * that round-trips an id through a form would get a 400 for data the server produced.
 */
const ID_RE = /^[0-9A-Za-z_-]{6,64}$/;

export class PostListQueryDto extends PaginationQuery {
  @ApiPropertyOptional({ description: 'Filter by blog category slug' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by tag slug' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tag?: string;

  @ApiPropertyOptional({ description: 'Search title, excerpt and body (full text + ILIKE fallback)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: ['newest', 'popular'], default: 'newest' })
  @IsOptional()
  @IsIn(['newest', 'popular'])
  sort?: 'newest' | 'popular';
}

export class AdminPostListQueryDto extends AdminPaginationQuery {
  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'any' })
  @IsOptional()
  @IsIn(STATUS_FILTERS as unknown as string[])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  tag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ description: 'Author username or id' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  author?: string;
}

export class CreatePostDto {
  @ApiProperty({ example: 'أفضل عشر ألعاب متصفح لعام 2026' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'URL slug; derived from the title when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(SLUG_RE, { message: 'slug may only contain letters, digits and single hyphens' })
  slug?: string;

  @ApiPropertyOptional({ description: 'Card/SEO summary; derived from the body when omitted', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  @ApiProperty({ description: 'Markdown body — stored as written, rendered by the web app' })
  @IsString()
  @MinLength(1)
  @MaxLength(200_000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  coverImage?: string;

  @ApiPropertyOptional({ description: 'Blog category slug' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({ type: [String], description: 'Up to 12 tags, created on first use' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: ContentStatus;

  @ApiPropertyOptional({ description: 'Required with status=scheduled: when the post goes live' })
  @IsOptional()
  @IsISO8601()
  publishAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(70)
  seoTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(165)
  seoDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  canonicalUrl?: string;
}

export class UpdatePostDto extends PartialType(CreatePostDto) {
  @ApiPropertyOptional({ description: 'Reassign the author (admin only)' })
  @IsOptional()
  @IsString()
  @Matches(ID_RE, { message: 'id is not a valid identifier' })
  authorId?: string;
}

export class UpsertBlogCategoryDto {
  @ApiPropertyOptional({ description: 'Omit to create, include to update' })
  @IsOptional()
  @IsString()
  @Matches(ID_RE, { message: 'id is not a valid identifier' })
  id?: string;

  @ApiProperty({ example: 'مراجعات' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(SLUG_RE, { message: 'slug may only contain letters, digits and single hyphens' })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ description: 'Parent category id — blog categories nest like game categories' })
  @IsOptional()
  @IsString()
  @Matches(ID_RE, { message: 'id is not a valid identifier' })
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** One block in the page builder's document. */
export class PageBlockDto {
  @ApiProperty({ enum: PAGE_BLOCK_TYPES })
  @IsIn(PAGE_BLOCK_TYPES as unknown as string[])
  type!: PageBlockType;

  @ApiPropertyOptional({ description: 'Stable id so the editor can reorder/patch one block' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  id?: string;

  @ApiPropertyOptional({ description: 'Type-specific props, validated against the type by the service' })
  @IsOptional()
  @IsObject()
  props?: Record<string, unknown>;
}

export class UpsertPageDto {
  @IsOptional()
  @IsString()
  @Matches(ID_RE, { message: 'id is not a valid identifier' })
  id?: string;

  @ApiProperty({ example: 'من نحن' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  titleEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(SLUG_RE, { message: 'slug may only contain letters, digits and single hyphens' })
  slug?: string;

  @ApiPropertyOptional({ description: 'Markdown body — the simple page, without blocks' })
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  body?: string;

  @ApiPropertyOptional({ type: [PageBlockDto], description: 'Page-builder document' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => PageBlockDto)
  blocks?: PageBlockDto[];

  @ApiPropertyOptional({ default: 'default', description: 'Layout the web app renders this page with' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9_-]+$/)
  template?: string;

  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: ContentStatus;

  @ApiPropertyOptional({ description: 'False keeps the page out of the sitemap and sends noindex' })
  @IsOptional()
  @IsBoolean()
  isIndexed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(70)
  seoTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(165)
  seoDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  canonicalUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class AdminPageListQueryDto extends AdminPaginationQuery {
  @IsOptional()
  @IsIn(STATUS_FILTERS as unknown as string[])
  status?: string;
}
