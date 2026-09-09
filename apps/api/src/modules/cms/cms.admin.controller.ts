/**
 * /api/admin/content — the editorial surface: blog posts, blog categories, pages.
 *
 * PERMISSIONS ARE DECLARATIVE, EXCEPT THE ONE THAT CANNOT BE:
 * `@Permissions('blog.update')` covers editing a post, but "move this post to
 * published" is a different right hiding inside the same request body (`status`). The
 * guard sees the route, not the payload, so CmsService re-checks `blog.publish` when
 * the status changes. An editor role that can write drafts therefore cannot push one
 * live, which is the whole reason publish is a separate permission.
 *
 * Every write is `@HttpCode(200)`, including creates: a client should not have to
 * branch on 200-vs-201 to know whether the save worked.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiPropertyOptional, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { IsBooleanString, IsOptional } from 'class-validator';
import { CurrentUser, Permissions, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { CmsService } from './cms.service.js';
import {
  AdminPageListQueryDto,
  AdminPostListQueryDto,
  CreatePostDto,
  UpdatePostDto,
  UpsertBlogCategoryDto,
  UpsertPageDto,
} from './dto/cms.dto.js';

/** `?hard=true` on a delete: query strings arrive as text, so validate the text. */
class HardDeleteQueryDto {
  @ApiPropertyOptional({ enum: ['true', 'false', '1', '0'], description: 'Permanently remove instead of archiving' })
  @IsOptional()
  @IsBooleanString()
  hard?: string;
}

const isTrue = (value?: string): boolean => value === 'true' || value === '1';

@ApiTags('admin · content')
@Controller('admin/content')
export class CmsAdminController {
  constructor(private readonly cms: CmsService) {}

  // ── posts ────────────────────────────────────────────────────────────────

  @Get('blog/posts')
  @Permissions('blog.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Every post in every status, filterable by status/category/tag/author/query' })
  @ApiResponse({ status: 200, description: 'A page of post cards (including drafts) plus total' })
  async listPosts(@Query() query: AdminPostListQueryDto) {
    return this.cms.adminPosts(query);
  }

  @Get('blog/posts/:ref')
  @Permissions('blog.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'One post for editing — by id or slug, in any status' })
  @ApiParam({ name: 'ref', description: 'Post id or slug' })
  async getPost(@CurrentUser() user: RequestUser, @Param('ref') ref: string) {
    return this.cms.adminPost(user, ref);
  }

  @Post('blog/posts')
  @HttpCode(200)
  @Permissions('blog.create')
  @RateLimit('admin')
  @ApiOperation({
    summary: 'Create a post (draft by default)',
    description:
      'The slug is derived from the title when omitted. status=published or scheduled requires the blog.publish permission.',
  })
  @ApiResponse({ status: 200, description: 'The created post' })
  @ApiResponse({ status: 403, description: 'Publishing or scheduling without blog.publish' })
  @ApiResponse({ status: 409, description: 'An explicit slug is already taken' })
  async createPost(@Req() req: Request, @CurrentUser() user: RequestUser, @Body() dto: CreatePostDto) {
    return this.cms.createPost(requestMeta(req), user, dto);
  }

  @Patch('blog/posts/:ref')
  @Permissions('blog.update')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Update a post partially — only the fields sent are touched' })
  @ApiParam({ name: 'ref', description: 'Post id or slug' })
  @ApiResponse({ status: 200, description: 'The updated post' })
  @ApiResponse({ status: 403, description: 'A status change to published/scheduled without blog.publish' })
  @ApiResponse({ status: 404, description: 'Unknown post' })
  @ApiResponse({ status: 409, description: 'The new slug belongs to another post' })
  async updatePost(@Req() req: Request, @CurrentUser() user: RequestUser, @Param('ref') ref: string, @Body() dto: UpdatePostDto) {
    return this.cms.updatePost(requestMeta(req), user, ref, dto);
  }

  @Post('blog/posts/:ref/publish')
  @HttpCode(200)
  @Permissions('blog.publish')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Publish now — sets publishedAt on first publish and never moves it again' })
  @ApiParam({ name: 'ref', description: 'Post id or slug' })
  async publishPost(@Req() req: Request, @CurrentUser() user: RequestUser, @Param('ref') ref: string) {
    return this.cms.publishPost(requestMeta(req), user, ref);
  }

  @Delete('blog/posts/:ref')
  @Permissions('blog.delete')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Archive a post (soft delete), or remove it for good with ?hard=true' })
  @ApiParam({ name: 'ref', description: 'Post id or slug' })
  @ApiQuery({ name: 'hard', required: false, enum: ['true', 'false'] })
  async deletePost(@Req() req: Request, @CurrentUser() user: RequestUser, @Param('ref') ref: string, @Query() query: HardDeleteQueryDto) {
    return this.cms.deletePost(requestMeta(req), user, ref, isTrue(query.hard));
  }

  @Post('blog/posts/:ref/restore')
  @HttpCode(200)
  @Permissions('blog.update')
  @RateLimit('admin')
  @ApiOperation({
    summary: 'Restore an archived post',
    description: 'Returns the post as archived, not published: going live again still needs blog.publish.',
  })
  @ApiParam({ name: 'ref', description: 'Post id or slug' })
  @ApiResponse({ status: 200, description: 'The restored post' })
  @ApiResponse({ status: 409, description: 'The post was not archived' })
  async restorePost(@Req() req: Request, @CurrentUser() user: RequestUser, @Param('ref') ref: string) {
    return this.cms.restorePost(requestMeta(req), user, ref);
  }

  // ── blog categories ──────────────────────────────────────────────────────

  @Get('blog/categories')
  @Permissions('blog.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Blog categories uncached — an editor must see the row they just wrote' })
  async listCategories() {
    return this.cms.adminBlogCategories();
  }

  @Post('blog/categories')
  @HttpCode(200)
  @Permissions('blog.create')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Create a blog category, or update one when id is present' })
  @ApiResponse({ status: 200, description: 'The category' })
  @ApiResponse({ status: 400, description: 'A category cannot be its own parent' })
  @ApiResponse({ status: 409, description: 'The slug belongs to another category' })
  async upsertCategory(@Req() req: Request, @CurrentUser() user: RequestUser, @Body() dto: UpsertBlogCategoryDto) {
    return this.cms.upsertBlogCategory(requestMeta(req), user, dto);
  }

  @Delete('blog/categories/:id')
  @Permissions('blog.delete')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Delete an empty blog category' })
  @ApiParam({ name: 'id', description: 'Category id' })
  @ApiResponse({ status: 200, description: 'Deletion result' })
  @ApiResponse({ status: 409, description: 'The category still has posts' })
  async deleteCategory(@Req() req: Request, @Param('id') id: string) {
    return this.cms.deleteBlogCategory(requestMeta(req), id);
  }

  // ── pages ────────────────────────────────────────────────────────────────

  @Get('pages')
  @Permissions('pages.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Every page in every status, with its blocks' })
  async listPages(@Query() query: AdminPageListQueryDto) {
    return this.cms.adminPages(query);
  }

  @Get('pages/:slug')
  @Permissions('pages.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'One page for editing, in any status' })
  @ApiParam({ name: 'slug', description: 'Page slug' })
  async getPage(@CurrentUser() user: RequestUser, @Param('slug') slug: string) {
    return this.cms.adminPage(user, slug);
  }

  @Post('pages')
  @HttpCode(200)
  @Permissions('pages.manage')
  @RateLimit('admin')
  @ApiOperation({
    summary: 'Create a page, or update one when id is present',
    description:
      'Blocks are validated against the shared PAGE_BLOCK_TYPES vocabulary; html blocks are sanitised and every URL prop goes through safeUrl. ' +
      'A slug that would shadow an application route (games, admin, blog…) is refused with 409.',
  })
  @ApiResponse({ status: 200, description: 'The page' })
  @ApiResponse({ status: 400, description: 'An unsafe URL in a block prop' })
  @ApiResponse({ status: 409, description: 'The slug is taken or reserved' })
  async upsertPage(@Req() req: Request, @Body() dto: UpsertPageDto) {
    return this.cms.upsertPage(requestMeta(req), dto);
  }

  @Post('pages/:id/restore')
  @HttpCode(200)
  @Permissions('pages.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Restore an archived page (it comes back unpublished)' })
  @ApiParam({ name: 'id', description: 'Page id' })
  @ApiResponse({ status: 200, description: 'The restored page' })
  @ApiResponse({ status: 409, description: 'The page was not archived' })
  async restorePage(@Req() req: Request, @Param('id') id: string) {
    return this.cms.restorePage(requestMeta(req), id);
  }

  @Delete('pages/:id')
  @Permissions('pages.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Archive a page, or remove it for good with ?hard=true' })
  @ApiParam({ name: 'id', description: 'Page id' })
  @ApiQuery({ name: 'hard', required: false, enum: ['true', 'false'] })
  async deletePage(@Req() req: Request, @Param('id') id: string, @Query() query: HardDeleteQueryDto) {
    return this.cms.deletePage(requestMeta(req), id, isTrue(query.hard));
  }
}
