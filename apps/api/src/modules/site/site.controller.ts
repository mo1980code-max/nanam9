/**
 * /api/settings, /api/sections, /api/themes and /api/redirects — the public site
 * surface.
 *
 * These four endpoints are what the Next.js shell reads on every render (settings
 * and theme), on the homepage (sections) and in middleware before a 404
 * (redirects). All of them are cached, all of them are safe for anonymous callers,
 * and none of them ever returns a value the site considers secret.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public, RateLimit } from '../../common/decorators/index.js';
import { SectionsQueryDto, RedirectQueryDto } from './dto/site.dto.js';
import { SiteService } from './site.service.js';

@ApiTags('site')
@Controller()
@Public()
export class SiteController {
  constructor(private readonly site: SiteService) {}

  @Get('settings')
  @RateLimit('global')
  @ApiOperation({ summary: 'Public settings as a flat map (site name, SEO defaults, feature flags)' })
  @ApiResponse({ status: 200, description: 'Key → value; credential-like keys are never included' })
  async settings(): Promise<Record<string, unknown>> {
    return this.site.publicSettings();
  }

  @Get('sections')
  @RateLimit('global')
  @ApiOperation({ summary: 'Visible homepage (or any page) sections, in builder order' })
  @ApiQuery({ name: 'page', required: false, example: 'home' })
  async sections(@Query() query: SectionsQueryDto) {
    const items = await this.site.sections(query);
    return { items, total: items.length, page: query.page ?? 'home' };
  }

  @Get('themes')
  @RateLimit('global')
  @ApiOperation({ summary: 'Themes for the switcher, plus which one is active' })
  async themes() {
    const items = await this.site.themes();
    return { items, total: items.length };
  }

  @Get('themes/active')
  @RateLimit('global')
  @ApiOperation({ summary: 'The theme a first-time visitor gets' })
  @ApiResponse({ status: 200, description: 'null when no theme is configured' })
  async activeTheme() {
    return this.site.activeTheme();
  }

  @Get('redirects/resolve')
  @RateLimit('search')
  @ApiOperation({ summary: 'Resolve a legacy path to its 301/302 target (called by web middleware)' })
  @ApiResponse({ status: 200, description: 'found:false when the path is not redirected' })
  async resolveRedirect(@Query() query: RedirectQueryDto) {
    return this.site.resolveRedirect(query);
  }
}
