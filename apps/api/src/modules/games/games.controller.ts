/**
 * /api/games — the public catalogue.
 *
 * ROUTE ORDER IS SEMANTIC: `search`, `random` and `continue` are declared before
 * `:slug`, because otherwise `/games/search` is a perfectly valid slug and the
 * detail handler would answer with a 404 for a page that exists. Express matches
 * top-down; there is no "more specific wins" rule.
 *
 * Everything here is `@Public()` on purpose. The catalogue is the SEO surface of
 * the product: a signed-in cookie must never change what a crawler receives, and
 * `detail()` folds the viewer's own state into a separate object so the public
 * payload stays cacheable at the CDN.
 */

import { Body, Controller, Get, Param, Post, Query, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { GameListQueryDto, LimitQueryDto, PlayEventDto } from './dto/game.dto.js';
import { GamesService } from './games.service.js';

@ApiTags('games')
@Controller('games')
@Public()
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  @RateLimit('global')
  @ApiOperation({ summary: 'List published games with filters, sorting and pagination' })
  @ApiResponse({ status: 200, description: 'A page of game cards plus pagination meta' })
  async list(@Req() req: Request, @Query() query: GameListQueryDto) {
    const result = await this.games.list(requestMeta(req), query);
    return { items: result.items, total: result.total };
  }

  @Get('search')
  @RateLimit('search')
  @ApiOperation({ summary: 'Full-text search (Arabic and English) over published games' })
  @ApiQuery({ name: 'q', required: true, description: 'Search term; diacritics and tatweel are folded' })
  async search(@Req() req: Request, @Query('q') term: string, @Query() query: GameListQueryDto) {
    const result = await this.games.search(requestMeta(req), String(term ?? '').slice(0, 120), query);
    return { items: result.items, total: result.total };
  }

  @Get('random')
  @RateLimit('global')
  @ApiOperation({ summary: 'A random selection — the "surprise me" button and the empty-state filler' })
  @ApiQuery({ name: 'category', required: false, description: 'Restrict the draw to one category' })
  async random(@Req() req: Request, @Query() query: LimitQueryDto, @Query('category') category?: string) {
    return { items: await this.games.random(requestMeta(req), query.limit, category || undefined) };
  }

  @Get('continue')
  @RateLimit('global')
  @ApiOperation({ summary: 'Recently played games — per account, or per anonymous session cookie' })
  async continuePlaying(@Req() req: Request, @CurrentUser() user: RequestUser | null, @Query() query: LimitQueryDto) {
    return { items: await this.games.continuePlaying(requestMeta(req), user, query.limit) };
  }

  @Post('play')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @RateLimit('play')
  @ApiOperation({ summary: 'Record a play. Awards XP and unlocks achievements for signed-in players.' })
  @ApiResponse({ status: 200, description: 'Counters after the play, plus any XP or badges awarded' })
  @ApiResponse({ status: 404, description: 'Unknown game' })
  async play(@Req() req: Request, @Body() dto: PlayEventDto, @CurrentUser() user: RequestUser | null) {
    return this.games.trackPlay(requestMeta(req), dto, user);
  }

  @Get(':slug')
  @RateLimit('global')
  @ApiOperation({ summary: 'One game: playable URL, metadata, related titles and the caller’s own state' })
  @ApiParam({ name: 'slug', description: 'Game slug (Arabic slugs are percent-encoded by the browser)' })
  @ApiResponse({ status: 200, description: 'Game detail' })
  @ApiResponse({ status: 404, description: 'No published game with this slug' })
  async detail(@Req() req: Request, @Param('slug') slug: string, @CurrentUser() user: RequestUser | null) {
    return this.games.detail(requestMeta(req), slug, user);
  }

  @Get(':slug/related')
  @RateLimit('global')
  @ApiOperation({ summary: 'Games in the same categories/tags — the rail under the player' })
  async related(@Req() req: Request, @Param('slug') slug: string, @Query() query: LimitQueryDto) {
    return { items: await this.games.related(requestMeta(req), slug, query.limit) };
  }
}
