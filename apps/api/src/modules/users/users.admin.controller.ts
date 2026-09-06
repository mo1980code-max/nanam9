/**
 * /api/admin/users — user administration.
 *
 * ROUTE ORDER: `users/roles` is declared before `users/:ref`. A reference is an open
 * parameter (an id or a username), so without that order the literal "roles" would be
 * looked up as a user and 404 — the kind of bug that only shows up after somebody
 * renames an account to "roles".
 *
 * `:ref` accepts an id OR a username because staff reach this screen two ways: from a
 * report (which stores an id) and from a search box (where they type a name). Making
 * the caller decide which one they have is how admin UIs end up with two lookups.
 *
 * The service, not the controller, enforces the privilege rules (no self-edits, no
 * lateral edits, no granting a role above your own, the last super-admin is
 * protected). Keeping them in the service means a future CLI or queue job that
 * changes a role inherits the same guarantees instead of bypassing them.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Permissions, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { UnauthorizedError } from '../../common/http/errors.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { AdminUpdateUserDto, BanUserDto, UserListQueryDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';

function staff(user: RequestUser | null): RequestUser {
  if (!user) throw new UnauthorizedError('sign in to continue');
  return user;
}

@ApiTags('admin · users')
@Controller('admin')
export class UsersAdminController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @Permissions('users.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Search and list accounts with role, status, XP and counters' })
  async list(@Query() query: UserListQueryDto) {
    return this.users.adminList(query);
  }

  @Get('users/roles')
  @Permissions('users.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Roles with their effective permissions (the role picker)' })
  async roles() {
    return this.users.roles();
  }

  @Get('users/:ref')
  @Permissions('users.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'One account by id or username' })
  @ApiParam({ name: 'ref', description: 'User id or username' })
  @ApiResponse({ status: 404, description: 'No such account' })
  async one(@Param('ref') ref: string) {
    return this.users.adminOne(ref);
  }

  @Patch('users/:ref')
  @Permissions('users.update')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Update an account: display name, email, bio, status, role, XP' })
  @ApiParam({ name: 'ref', description: 'User id or username' })
  @ApiResponse({ status: 403, description: 'Target is you, a peer, or above your role' })
  @ApiResponse({ status: 409, description: 'Email already taken, or this would remove the last super admin' })
  async update(@Req() req: Request, @Param('ref') ref: string, @Body() dto: AdminUpdateUserDto, @CurrentUser() user: RequestUser | null) {
    return this.users.adminUpdate(requestMeta(req), staff(user), ref, dto);
  }

  @Post('users/:ref/ban')
  @HttpCode(200)
  @Permissions('users.ban')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Ban an account and revoke every one of its sessions immediately' })
  @ApiParam({ name: 'ref', description: 'User id or username' })
  @ApiResponse({ status: 409, description: 'This account is the last active super admin' })
  async ban(@Req() req: Request, @Param('ref') ref: string, @Body() dto: BanUserDto, @CurrentUser() user: RequestUser | null) {
    return this.users.ban(requestMeta(req), staff(user), ref, dto);
  }

  @Post('users/:ref/unban')
  @HttpCode(200)
  @Permissions('users.ban')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Lift a ban (the account returns to `active`, never to `pending`)' })
  @ApiParam({ name: 'ref', description: 'User id or username' })
  async unban(@Req() req: Request, @Param('ref') ref: string, @CurrentUser() user: RequestUser | null) {
    return this.users.unban(requestMeta(req), staff(user), ref);
  }

  @Delete('users/:ref')
  @Permissions('users.update')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Soft-delete an account; its comments, ratings and playlists stay attributed' })
  @ApiParam({ name: 'ref', description: 'User id or username' })
  async remove(@Req() req: Request, @Param('ref') ref: string, @CurrentUser() user: RequestUser | null) {
    return this.users.softDelete(requestMeta(req), staff(user), ref);
  }
}
