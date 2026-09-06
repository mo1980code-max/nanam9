/**
 * /api/admin/settings, /sections, /themes, /redirects, /activity — site management.
 *
 * ROUTE ORDER MATTERS: `sections/reorder` is declared before `sections/:id`, and
 * `themes/active`-style literals before `themes/:slug`, because Nest matches in
 * declaration order and `:id` would happily swallow the word "reorder".
 *
 * Every write is `@HttpCode(200)` even when it may insert a row: these are upserts,
 * and a client that has to branch on 200-vs-201 for "did the save work?" is a client
 * that eventually gets it wrong.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permissions, RateLimit } from '../../common/decorators/index.js';
import { AdminPaginationQuery, PaginationQuery } from '../../common/dto/pagination.dto.js';
import { requestMeta } from '../../common/http/request-meta.js';
import {
  ActivityQueryDto,
  ReorderSectionsDto,
  SectionsQueryDto,
  SettingsQueryDto,
  UpsertRedirectDto,
  UpsertSectionDto,
  UpsertSettingDto,
  UpsertSettingsDto,
  UpsertThemeDto,
} from './dto/site.dto.js';
import { SiteService } from './site.service.js';

@ApiTags('admin · site')
@Controller('admin')
export class SiteAdminController {
  constructor(private readonly site: SiteService) {}

  // ── settings ─────────────────────────────────────────────────────────────

  @Get('settings')
  @Permissions('settings.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Every setting with its type, group and help text (defaults flagged as unstored)' })
  async list(@Query() query: SettingsQueryDto) {
    const items = await this.site.allSettings(query);
    return { items, total: items.length, groups: [...new Set(items.map((i) => i.group))].sort() };
  }

  @Put('settings')
  @Permissions('settings.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Save a whole settings tab at once (per-key results, one audit line)' })
  @ApiResponse({ status: 200, description: 'updated/rejected counts plus per-key results' })
  async saveMany(@Req() req: Request, @Body() dto: UpsertSettingsDto) {
    return this.site.setMany(requestMeta(req), dto.settings);
  }

  @Post('settings')
  @HttpCode(200)
  @Permissions('settings.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Create or update one setting' })
  @ApiResponse({ status: 400, description: 'Value does not match the declared type, or a credential was marked public' })
  async saveOne(@Req() req: Request, @Body() dto: UpsertSettingDto) {
    return this.site.setOne(requestMeta(req), dto);
  }

  @Delete('settings/:key')
  @Permissions('settings.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Delete a setting (reverts to its factory default when one exists)' })
  @ApiParam({ name: 'key', example: 'seo.keywords' })
  async removeSetting(@Req() req: Request, @Param('key') key: string) {
    return this.site.remove(requestMeta(req), key);
  }

  // ── homepage sections ────────────────────────────────────────────────────

  @Get('sections')
  @Permissions('sections.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Sections of a page, hidden ones included' })
  async sections(@Query() query: SectionsQueryDto) {
    const items = await this.site.sections(query, { includeHidden: true });
    return { items, total: items.length, page: query.page ?? 'home' };
  }

  @Post('sections/reorder')
  @HttpCode(200)
  @Permissions('sections.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Persist the drag-and-drop order' })
  async reorderSections(@Req() req: Request, @Body() dto: ReorderSectionsDto) {
    return this.site.reorderSections(requestMeta(req), dto);
  }

  @Post('sections')
  @HttpCode(200)
  @Permissions('sections.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Create a section, or update one when `id` is present' })
  async upsertSection(@Req() req: Request, @Body() dto: UpsertSectionDto) {
    return this.site.upsertSection(requestMeta(req), dto);
  }

  @Delete('sections/:id')
  @Permissions('sections.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Delete a section' })
  @ApiParam({ name: 'id' })
  async removeSection(@Req() req: Request, @Param('id') id: string) {
    return this.site.removeSection(requestMeta(req), id);
  }

  // ── themes ───────────────────────────────────────────────────────────────

  @Get('themes')
  @Permissions('themes.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'All themes with their token config' })
  async themes() {
    const items = await this.site.themes();
    return { items, total: items.length };
  }

  @Post('themes')
  @HttpCode(200)
  @Permissions('themes.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Register or update a theme (upsert by slug)' })
  async upsertTheme(@Req() req: Request, @Body() dto: UpsertThemeDto) {
    return this.site.upsertTheme(requestMeta(req), dto);
  }

  @Post('themes/:slug/activate')
  @HttpCode(200)
  @Permissions('themes.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Make a theme the active/default one for every visitor' })
  @ApiParam({ name: 'slug', example: 'neon-dark' })
  async activateTheme(@Req() req: Request, @Param('slug') slug: string, @Query('default') asDefault?: string) {
    return this.site.activateTheme(requestMeta(req), slug, { asDefault: asDefault === '1' || asDefault === 'true' });
  }

  // ── redirects ────────────────────────────────────────────────────────────

  @Get('redirects')
  @Permissions('settings.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Redirect table with hit counts' })
  async redirects(@Query() query: AdminPaginationQuery) {
    return this.site.redirects(query.pageArg);
  }

  @Post('redirects')
  @HttpCode(200)
  @Permissions('settings.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Create or update a redirect (upsert by source path)' })
  @ApiResponse({ status: 400, description: 'Target is external, self-referencing or malformed' })
  async upsertRedirect(@Req() req: Request, @Body() dto: UpsertRedirectDto) {
    return this.site.upsertRedirect(requestMeta(req), dto);
  }

  @Delete('redirects/:id')
  @Permissions('settings.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Delete a redirect' })
  @ApiParam({ name: 'id' })
  async removeRedirect(@Req() req: Request, @Param('id') id: string) {
    return this.site.removeRedirect(requestMeta(req), id);
  }

  // ── activity log ─────────────────────────────────────────────────────────

  @Get('activity')
  @Permissions('activity.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Activity log, newest first, filterable by actor and action' })
  async activity(@Query() query: ActivityQueryDto) {
    return this.site.activity(query);
  }
}
