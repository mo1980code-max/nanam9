/**
 * /api/admin/ads — ad manager (admin) + /api/ads live slot (public).
 *
 * WHY TWO CONCERNS IN ONE CONTROLLER:
 * - The same repository backs both: admin writes and public reads. Splitting them
 *   into two controllers would duplicate the placement validation and the cache
 *   semantics. One file, two route groups (admin vs public) keeps the placement
 *   vocabulary in one place.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permissions, RateLimit } from '../../common/decorators/index.js';
import { Public } from '../../common/decorators/index.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { AdsService } from './ads.service.js';
import { AdsQueryDto, CreateAdDto, UpdateAdDto } from './dto/ads.dto.js';

@ApiTags('admin · ads')
@Controller()
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  // ── public live slot — what the portal shell renders on every page ────────
  @Public()
  @Get('ads')
  @RateLimit('global')
  @ApiOperation({ summary: 'Live ads for a placement (active + inside window, ordered by priority)' })
  async live(@Query('placement') placement?: string) {
    const slot = placement?.trim();
    if (!slot) return { items: [], total: 0, placement: null };
    const items = await this.ads.forPlacement(slot);
    return { items, total: items.length, placement: slot };
  }

  // ── admin manager ─────────────────────────────────────────────────────────
  @Get('admin/ads')
  @Permissions('ads.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'All ad slots, filterable by placement and status' })
  async list(@Query() query: AdsQueryDto) {
    const items = await this.ads.list(query);
    return { items, total: items.length };
  }

  @Post('admin/ads')
  @Permissions('ads.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Create an ad slot' })
  async create(@Req() req: Request, @Body() dto: CreateAdDto) {
    return this.ads.create(requestMeta(req), dto);
  }

  @Patch('admin/ads/:id')
  @Permissions('ads.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Update an ad slot' })
  @ApiParam({ name: 'id' })
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateAdDto) {
    return this.ads.update(requestMeta(req), id, dto);
  }

  @Delete('admin/ads/:id')
  @Permissions('ads.manage')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Delete an ad slot' })
  @ApiParam({ name: 'id' })
  async remove(@Req() req: Request, @Param('id') id: string) {
    return this.ads.remove(requestMeta(req), id);
  }

  // impression/click — public but rate-limited; never blocks rendering
  @Public()
  @Post('ads/:id/track')
  @HttpCode(200)
  @RateLimit('global')
  @ApiOperation({ summary: 'Record an impression or click for an ad (fire-and-forget)' })
  @ApiParam({ name: 'id' })
  async track(@Param('id') id: string, @Body() body: { event?: string }) {
    const event = body?.event === 'click' ? 'click' : 'impression';
    await this.ads.track(id, event as 'impression' | 'click');
    return { tracked: true, event };
  }
}
