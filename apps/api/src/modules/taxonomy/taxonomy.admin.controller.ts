/**
 * /api/admin/categories and /api/admin/tags — taxonomy management.
 *
 * Deleting a category re-parents its children instead of cascading, and every slug
 * change writes a 301. Both rules exist because taxonomy edits are the easiest way
 * to accidentally destroy a site's internal link graph.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permissions, RateLimit } from '../../common/decorators/index.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { CreateCategoryDto, ReorderCategoriesDto, TagQueryDto, UpdateCategoryDto, UpsertTagsDto } from './dto/taxonomy.dto.js';
import { TaxonomyService } from './taxonomy.service.js';

@ApiTags('admin · taxonomy')
@Controller('admin')
export class TaxonomyAdminController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  @Get('categories')
  @Permissions('categories.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Every category, hidden ones included' })
  async list(@Req() req: Request, @Query('tree') tree?: string) {
    const meta = requestMeta(req);
    const items = tree === '0' || tree === 'false'
      ? await this.taxonomy.flat(meta, { includeHidden: true })
      : await this.taxonomy.tree(meta, { includeHidden: true });
    return { items, total: items.length };
  }

  @Post('categories')
  @Permissions('categories.manage')
  @RateLimit('write')
  @ApiOperation({ summary: 'Create a category (parent given by slug)' })
  @ApiResponse({ status: 201, description: 'Category created' })
  async create(@Req() req: Request, @Body() dto: CreateCategoryDto) {
    return this.taxonomy.create(requestMeta(req), dto);
  }

  @Post('categories/reorder')
  @HttpCode(200)
  @Permissions('categories.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Persist the drag-and-drop order of the menu' })
  async reorder(@Req() req: Request, @Body() dto: ReorderCategoriesDto) {
    return this.taxonomy.reorder(requestMeta(req), dto);
  }

  @Post('categories/recount')
  @HttpCode(200)
  @Permissions('categories.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Re-derive games_count for every category and tag' })
  async recount(@Req() req: Request) {
    return this.taxonomy.recount(requestMeta(req));
  }

  @Patch('categories/:id')
  @Permissions('categories.manage')
  @RateLimit('write')
  @ApiOperation({ summary: 'Update a category. Refuses moves that would create a cycle.' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 400, description: 'Cycle, unknown parent, or invalid slug' })
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.taxonomy.update(requestMeta(req), id, dto);
  }

  @Delete('categories/:id')
  @Permissions('categories.manage')
  @RateLimit('write')
  @ApiOperation({ summary: 'Delete a category; its children move up to its parent' })
  @ApiParam({ name: 'id' })
  async remove(@Req() req: Request, @Param('id') id: string) {
    return this.taxonomy.remove(requestMeta(req), id);
  }

  @Get('tags')
  @Permissions('tags.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Tags in either scope (game or blog)' })
  async tags(@Req() req: Request, @Query() query: TagQueryDto) {
    const items = await this.taxonomy.tags(requestMeta(req), query);
    return { items, total: items.length };
  }

  @Post('tags')
  @HttpCode(200)
  @Permissions('tags.manage')
  @RateLimit('write')
  @ApiOperation({ summary: 'Create tags in bulk (idempotent by slug + scope)' })
  async upsertTags(@Req() req: Request, @Body() dto: UpsertTagsDto) {
    const items = await this.taxonomy.upsertTags(requestMeta(req), dto);
    return { items, total: items.length };
  }
}
