/**
 * Public content routes: the blog and the static pages.
 *
 * WHY `/blog/posts` AND NOT `/blog/:slug`: with a bare `:slug` the literal
 * `categories` becomes a post slug that can never be read, and the fix people reach
 * for — declaring `categories` first — works only until somebody adds `/blog/tags`
 * six months later and forgets the ordering rule. Two path segments make the
 * collision structurally impossible.
 *
 * The web app's *page* URLs stay short (`/about`, `/terms`) because that is what
 * ranks and what people type; the API does not have to mirror them one-for-one, and
 * here it deliberately does not.
 */

import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { CmsService } from './cms.service.js';
import { PostListQueryDto } from './dto/cms.dto.js';

@ApiTags('content')
@Controller()
@Public()
export class CmsController {
  constructor(private readonly cms: CmsService) {}

  // ── blog ─────────────────────────────────────────────────────────────────

  @Get('blog/categories')
  @RateLimit('global')
  @ApiOperation({ summary: 'Blog categories, flat and as a tree, with live post counts' })
  @ApiResponse({ status: 200, description: 'items (flat) + tree (nested children)' })
  async categories() {
    return this.cms.blogCategories();
  }

  @Get('blog/posts')
  @RateLimit('global')
  @ApiOperation({ summary: 'Published posts, newest or most-read first, filterable by category/tag/query' })
  @ApiResponse({ status: 200, description: 'A page of post cards plus total' })
  async posts(@Query() query: PostListQueryDto) {
    return this.cms.posts(query);
  }

  @Get('blog/posts/:slug')
  @RateLimit('global')
  @ApiOperation({
    summary: 'One post: Markdown body, tags, related posts, SEO fields and JSON-LD',
    description:
      'Anonymous visitors only ever see live posts (published, or scheduled whose time has come). ' +
      'A staff viewer holding blog.view also gets drafts and archived posts with preview: true.',
  })
  @ApiParam({ name: 'slug', description: 'Post slug' })
  @ApiResponse({ status: 200, description: 'The post, ready to render' })
  @ApiResponse({ status: 404, description: 'Unknown slug, or a post that is not live yet' })
  async post(@Req() req: Request, @Param('slug') slug: string, @CurrentUser() user: RequestUser | null) {
    return this.cms.post(requestMeta(req), slug, user);
  }

  // ── pages ────────────────────────────────────────────────────────────────

  @Get('pages')
  @RateLimit('global')
  @ApiOperation({ summary: 'Published pages for the footer and navigation menus' })
  async pages() {
    return this.cms.livePages();
  }

  @Get('pages/:slug')
  @RateLimit('global')
  @ApiOperation({
    summary: 'One page: body, validated builder blocks, SEO fields, JSON-LD (incl. FAQPage)',
    description: 'Unpublished pages return 404 to visitors; a viewer holding pages.manage gets a preview.',
  })
  @ApiParam({ name: 'slug', description: 'Page slug — pages are served at /{slug} on the web app' })
  @ApiResponse({ status: 200, description: 'The page, ready to render' })
  @ApiResponse({ status: 404, description: 'Unknown slug, or a page that is not published' })
  async page(@Param('slug') slug: string, @CurrentUser() user: RequestUser | null) {
    return this.cms.page(slug, user);
  }
}
