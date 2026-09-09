/**
 * /api/comments, /api/votes, /api/ratings, /api/favorites, /api/playlists, /api/reports
 *
 * Guest-facing reads are `@Public()`; anything that writes is authenticated and
 * rate-limited, because a comment endpoint without a limit is a spam endpoint.
 * Reporting is deliberately allowed for guests (abuse must be reportable by the
 * people who see it) but rate-limited harder and recorded with a hashed IP.
 */

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { UnauthorizedError } from '../../common/http/errors.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import {
  CommentsQueryDto,
  CreateCommentDto,
  CreatePlaylistDto,
  GameRefDto,
  PlaylistGameDto,
  PlaylistGamesBulkDto,
  RateDto,
  RatingsQueryDto,
  ReportDto,
  UpdateCommentDto,
  UpdatePlaylistDto,
  VoteDto,
} from './dto/social.dto.js';
import { SocialService } from './social.service.js';

@ApiTags('social')
@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  // ── comments ─────────────────────────────────────────────────────────────

  @Get('comments')
  @Public()
  @RateLimit('global')
  @ApiOperation({ summary: 'Threaded comments for a game or a blog post' })
  async comments(@Req() req: Request, @Query() query: CommentsQueryDto, @CurrentUser() user: RequestUser | null) {
    const result = await this.social.comments(requestMeta(req), query, user);
    return { items: result.items, total: result.total };
  }

  @Post('comments')
  @Public()
  @RateLimit('comment')
  @ApiOperation({ summary: 'Comment on a game or post. Guests are pre-moderated; members publish immediately.' })
  @ApiResponse({ status: 201, description: 'Created (or held for moderation — see `moderated`)' })
  async createComment(@Req() req: Request, @Body() dto: CreateCommentDto, @CurrentUser() user: RequestUser | null) {
    return this.social.createComment(requestMeta(req), dto, user);
  }

  @Patch('comments/:id')
  @RateLimit('write')
  @ApiOperation({ summary: 'Edit your own comment (moderators may edit any, and it is logged)' })
  @ApiParam({ name: 'id' })
  async updateComment(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCommentDto, @CurrentUser() user: RequestUser | null) {
    return this.social.updateComment(requestMeta(req), id, dto, requireUser(user));
  }

  @Delete('comments/:id')
  @RateLimit('write')
  @ApiOperation({ summary: 'Delete your own comment (soft; moderators may hard-delete)' })
  @ApiParam({ name: 'id' })
  async deleteComment(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: RequestUser | null, @Query('hard') hard?: string) {
    return this.social.deleteComment(requestMeta(req), id, requireUser(user), { hard: hard === '1' || hard === 'true' });
  }

  // ── votes, ratings, favourites ───────────────────────────────────────────

  @Post('votes')
  @RateLimit('write')
  @ApiOperation({ summary: 'Like (1), dislike (-1) or withdraw (0) a vote on a game or comment' })
  async vote(@Req() req: Request, @Body() dto: VoteDto, @CurrentUser() user: RequestUser | null) {
    return this.social.vote(requestMeta(req), dto, requireUser(user));
  }

  @Post('ratings')
  @RateLimit('write')
  @ApiOperation({ summary: 'Rate a game 1–5 stars, optionally with a written review' })
  async rate(@Req() req: Request, @Body() dto: RateDto, @CurrentUser() user: RequestUser | null) {
    return this.social.rate(requestMeta(req), dto, requireUser(user));
  }

  @Get('ratings')
  @Public()
  @RateLimit('global')
  @ApiOperation({ summary: 'A game’s reviews plus the star breakdown (feeds Schema.org Review)' })
  async ratings(@Req() req: Request, @Query() query: RatingsQueryDto) {
    const result = await this.social.ratings(requestMeta(req), query.game, query.pageArg);
    return { items: result.items, total: result.total, average: result.average, count: result.count, breakdown: result.breakdown };
  }

  @Post('favorites')
  @RateLimit('write')
  @ApiOperation({ summary: 'Toggle a game in the caller’s favourites' })
  async toggleFavorite(@Req() req: Request, @Body() dto: GameRefDto, @CurrentUser() user: RequestUser | null) {
    return this.social.toggleFavorite(requestMeta(req), dto.game, requireUser(user));
  }

  @Get('me/favorites')
  @RateLimit('global')
  @ApiOperation({ summary: 'The caller’s favourite games' })
  async favorites(@Req() req: Request, @CurrentUser() user: RequestUser | null, @Query() query: PaginationQuery) {
    const result = await this.social.favorites(requestMeta(req), requireUser(user), query.pageArg);
    return { items: result.items, total: result.total };
  }

  // ── playlists ────────────────────────────────────────────────────────────

  @Get('playlists')
  @Public()
  @RateLimit('global')
  @ApiOperation({ summary: 'Playlists — the caller’s own, or another member’s public ones via ?owner=username' })
  async playlists(@Req() req: Request, @CurrentUser() user: RequestUser | null, @Query('owner') owner?: string) {
    const items = await this.social.playlists(requestMeta(req), user, owner || undefined);
    return { items, total: items.length };
  }

  @Post('playlists')
  @RateLimit('write')
  @ApiOperation({ summary: 'Create a shareable playlist (private, unlisted or public)' })
  async createPlaylist(@Req() req: Request, @Body() dto: CreatePlaylistDto, @CurrentUser() user: RequestUser | null) {
    return this.social.createPlaylist(requestMeta(req), dto, requireUser(user));
  }

  @Get('playlists/:ref')
  @Public()
  @RateLimit('global')
  @ApiOperation({ summary: 'One playlist by id, slug or share token, with its games' })
  @ApiParam({ name: 'ref', description: 'Playlist id, slug or share token' })
  @ApiResponse({ status: 404, description: 'Unknown playlist, or a private one you may not see' })
  async playlist(@Req() req: Request, @Param('ref') ref: string, @CurrentUser() user: RequestUser | null) {
    return this.social.playlist(requestMeta(req), ref, user);
  }

  @Patch('playlists/:ref')
  @RateLimit('write')
  @ApiOperation({ summary: 'Rename, re-describe, re-cover or change the visibility of a playlist' })
  async updatePlaylist(@Req() req: Request, @Param('ref') ref: string, @Body() dto: UpdatePlaylistDto, @CurrentUser() user: RequestUser | null) {
    return this.social.updatePlaylist(requestMeta(req), ref, dto, requireUser(user));
  }

  @Delete('playlists/:ref')
  @RateLimit('write')
  @ApiOperation({ summary: 'Delete a playlist' })
  async deletePlaylist(@Req() req: Request, @Param('ref') ref: string, @CurrentUser() user: RequestUser | null) {
    return this.social.deletePlaylist(requestMeta(req), ref, requireUser(user));
  }

  @Post('playlists/:ref/games')
  @RateLimit('write')
  @ApiOperation({ summary: 'Add one game to a playlist' })
  async addGame(@Req() req: Request, @Param('ref') ref: string, @Body() dto: PlaylistGameDto, @CurrentUser() user: RequestUser | null) {
    return this.social.addToPlaylist(requestMeta(req), ref, dto, requireUser(user));
  }

  @Post('playlists/:ref/games/bulk')
  @RateLimit('write')
  @ApiOperation({ summary: 'Add many games at once (the "add to playlist" dialog)' })
  async addGames(@Req() req: Request, @Param('ref') ref: string, @Body() dto: PlaylistGamesBulkDto, @CurrentUser() user: RequestUser | null) {
    return this.social.addManyToPlaylist(requestMeta(req), ref, dto, requireUser(user));
  }

  @Delete('playlists/:ref/games/:game')
  @RateLimit('write')
  @ApiOperation({ summary: 'Remove a game from a playlist' })
  @ApiParam({ name: 'game', description: 'Game slug or id' })
  async removeGame(@Req() req: Request, @Param('ref') ref: string, @Param('game') game: string, @CurrentUser() user: RequestUser | null) {
    return this.social.removeFromPlaylist(requestMeta(req), ref, game, requireUser(user));
  }

  // ── reports ──────────────────────────────────────────────────────────────

  @Post('reports')
  @Public()
  // Its own bucket: reporting shares nothing with commenting, and a user who just
  // posted ten comments must still be able to report the spam they are looking at.
  @RateLimit('write')
  @ApiOperation({ summary: 'Report a game, comment, post or user. One report per reporter per target.' })
  @ApiResponse({ status: 201, description: 'Reported (or already reported by you)' })
  async report(@Req() req: Request, @Body() dto: ReportDto, @CurrentUser() user: RequestUser | null) {
    return this.social.report(requestMeta(req), dto, user);
  }
}

function requireUser(user: RequestUser | null): RequestUser {
  if (!user) throw new UnauthorizedError('session', 'sign in to continue');
  return user;
}
