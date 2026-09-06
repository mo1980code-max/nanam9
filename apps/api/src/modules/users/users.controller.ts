/**
 * /api/me/* (self service), /api/users/:username and /api/leaderboard (public).
 *
 * The self-service routes are declared before the public ones only for readability —
 * they cannot collide, because `me/…` and `users/:username` are different literal
 * prefixes. What DOES matter is that `leaderboard` is declared before
 * `users/:username`, since a username is an open parameter and would otherwise
 * capture the word "leaderboard" if the routes were ever re-rooted.
 *
 * Reads of your own data return the same shape as a public profile plus the private
 * fields (email, timezone, 2FA state), so the web app needs one type and one
 * conditional spread instead of two mappers.
 */

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { AppError, UnauthorizedError } from '../../common/http/errors.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { HistoryQueryDto, LeaderboardQueryDto, PublicProfileQueryDto, UpdateProfileDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';

/** Every `/me` route needs a real user; the guard already refused anonymous calls. */
function me(user: RequestUser | null): RequestUser {
  if (!user) throw new UnauthorizedError('sign in to continue');
  return user;
}

/** Notification ids are bigints in the database and strings on the wire. */
function notificationId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) throw new AppError('notification.invalid_id', 'notification ids are positive numbers', 400);
  return id;
}

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // ── self service ─────────────────────────────────────────────────────────

  @Get('me/profile')
  @RateLimit('global')
  @ApiOperation({ summary: 'Your profile, including private fields and level progress' })
  async myProfile(@CurrentUser() user: RequestUser | null) {
    return this.users.myProfile(me(user));
  }

  @Patch('me/profile')
  @RateLimit('write')
  @ApiOperation({ summary: 'Update your display name, bio, website, language, timezone or avatar' })
  @ApiResponse({ status: 400, description: 'Nothing to update, or a website/avatar URL that is not allowed' })
  @ApiResponse({ status: 403, description: 'Email, role, status and XP are not editable here' })
  async updateProfile(@Req() req: Request, @Body() dto: UpdateProfileDto, @CurrentUser() user: RequestUser | null) {
    return this.users.updateProfile(requestMeta(req), me(user), dto);
  }

  @Get('me/stats')
  @RateLimit('global')
  @ApiOperation({ summary: 'XP, level progress, action counters and badge totals' })
  async myStats(@CurrentUser() user: RequestUser | null) {
    return this.users.myStats(me(user));
  }

  @Get('me/achievements')
  @RateLimit('global')
  @ApiOperation({ summary: 'Your badge grid with per-badge progress (hidden badges stay hidden)' })
  async myAchievements(@CurrentUser() user: RequestUser | null) {
    const items = await this.users.myAchievements(me(user));
    return { items, total: items.length };
  }

  @Get('me/history')
  @RateLimit('global')
  @ApiOperation({ summary: 'Your play history, newest first' })
  async myHistory(@Query() query: HistoryQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.users.myHistory(query, me(user));
  }

  @Get('me/notifications')
  @RateLimit('global')
  @ApiOperation({ summary: 'Your notifications plus the unread count for the bell badge' })
  async myNotifications(@Query() query: PaginationQuery, @CurrentUser() user: RequestUser | null) {
    return this.users.myNotifications(query.pageArg, me(user));
  }

  @Post('me/notifications/read-all')
  @HttpCode(200)
  @RateLimit('write')
  @ApiOperation({ summary: 'Mark every notification read' })
  async readAll(@CurrentUser() user: RequestUser | null) {
    return this.users.markAllNotificationsRead(me(user));
  }

  @Post('me/notifications/:id/read')
  @HttpCode(200)
  @RateLimit('write')
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiParam({ name: 'id', description: 'Numeric notification id' })
  @ApiResponse({ status: 404, description: 'Not yours, or it does not exist' })
  async readOne(@Param('id') id: string, @CurrentUser() user: RequestUser | null) {
    return this.users.markNotificationRead(notificationId(id), me(user));
  }

  // ── public ───────────────────────────────────────────────────────────────

  @Get('leaderboard')
  @Public()
  @RateLimit('global')
  @ApiOperation({ summary: 'Top players by XP or by plays (active accounts only)' })
  async leaderboard(@Query() query: LeaderboardQueryDto) {
    return this.users.leaderboard(query);
  }

  @Get('users/:username')
  @Public()
  @RateLimit('global')
  @ApiOperation({ summary: 'A public profile: level, badges, counts and public playlists' })
  @ApiParam({ name: 'username' })
  @ApiResponse({ status: 404, description: 'Unknown, banned or deleted account' })
  async publicProfile(@Param('username') username: string, @Query() query: PublicProfileQueryDto) {
    return this.users.publicProfile(username, query);
  }
}
