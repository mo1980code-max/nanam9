/**
 * /api/categories and /api/tags — the navigation surface.
 *
 * `suggest` is declared before `:slug` (same rule as the games controller), and the
 * category tree is the ONLY endpoint the web app needs to render the whole menu:
 * one request, cached at the CDN, instead of one request per menu level.
 */

import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, RateLimit } from '../../common/decorators/index.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { CategoryQueryDto, SuggestQueryDto, TagQueryDto } from './dto/taxonomy.dto.js';
import { TaxonomyService } from './taxonomy.service.js';

@ApiTags('taxonomy')
@Controller()
@Public()
export class TaxonomyController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  @Get('categories')
  @RateLimit('global')
  @ApiOperation({ summary: 'Category tree (nested) or flat list, with game counts' })
  @ApiResponse({ status: 200, description: 'Categories ready to render as a menu' })
  async categories(@Req() req: Request, @Query() query: CategoryQueryDto) {
    const meta = requestMeta(req);
    const items = query.wantsTree
      ? await this.taxonomy.tree(meta, { includeHidden: query.wantsAll })
      : await this.taxonomy.flat(meta, { includeHidden: query.wantsAll });
    return { items, total: items.length };
  }

  @Get('categories/suggest')
  @RateLimit('search')
  @ApiOperation({ summary: 'Instant-search suggestions across categories, tags and games' })
  async suggest(@Req() req: Request, @Query() query: SuggestQueryDto) {
    return this.taxonomy.suggest(requestMeta(req), query.q, query.limit);
  }

  @Get('categories/:slug')
  @RateLimit('global')
  @ApiOperation({ summary: 'One category with its ancestors (breadcrumb) and children' })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 404, description: 'Unknown or hidden category' })
  async category(@Req() req: Request, @Param('slug') slug: string) {
    const meta = requestMeta(req);
    return this.taxonomy.bySlug(meta, slug, { includeHidden: false });
  }

  @Get('tags')
  @RateLimit('global')
  @ApiOperation({ summary: 'Tags, optionally filtered by a partial name (the tag cloud and autocomplete)' })
  async tags(@Req() req: Request, @Query() query: TagQueryDto) {
    const items = await this.taxonomy.tags(requestMeta(req), query);
    return { items, total: items.length };
  }

  @Get('tags/:slug')
  @RateLimit('global')
  @ApiOperation({ summary: 'One tag' })
  @ApiParam({ name: 'slug' })
  async tag(@Req() req: Request, @Param('slug') slug: string) {
    return this.taxonomy.tagBySlug(requestMeta(req), slug);
  }
}
