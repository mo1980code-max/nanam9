/**
 * Users DTOs — self-service profile, public profiles, the leaderboard and admin
 * user management.
 *
 * THE SPLIT IS DELIBERATE. `UpdateProfileDto` (what a member may change about
 * themselves) and `AdminUpdateUserDto` (what staff may change about anybody) share
 * almost no fields: a member cannot touch `email`, `status`, `role` or `xp`, and an
 * admin changing those goes through a different endpoint with a different permission
 * and a different audit action. One DTO with optional privileged fields is how a
 * mass-assignment bug gets shipped.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROLE_SLUGS, UserStatus } from '@voltade/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsBooleanString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminPaginationQuery, PaginationQuery } from '../../../common/dto/pagination.dto.js';

const STATUSES = Object.values(UserStatus);

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Shown everywhere the username would be', minLength: 2, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  displayName?: string;

  @ApiPropertyOptional({ description: 'Plain text — markup is stripped, not rendered', maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  bio?: string;

  @ApiPropertyOptional({ description: 'Personal site or social profile; https is added when no scheme is given', example: 'https://example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  website?: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'], description: 'Interface language; also decides which titles the API localises' })
  @IsOptional()
  @IsIn(['ar', 'en'])
  locale?: string;

  @ApiPropertyOptional({ description: 'IANA timezone, used for daily streaks and “today” in stats', example: 'Asia/Amman' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Avatar path or URL (use POST /api/me/avatar to upload one)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;
}

export class PublicProfileQueryDto {
  @ApiPropertyOptional({ description: 'Include the visitor’s public playlists', default: true })
  @IsOptional()
  @IsBooleanString()
  playlists?: string;
}

export class LeaderboardQueryDto extends PaginationQuery {
  @ApiPropertyOptional({ enum: ['xp', 'plays'], default: 'xp', description: 'Ranking metric' })
  @IsOptional()
  @IsIn(['xp', 'plays'])
  metric?: 'xp' | 'plays';
}

export class HistoryQueryDto extends PaginationQuery {
  @ApiPropertyOptional({ description: 'Narrow the history to one game (slug or id)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  game?: string;
}

export class UserListQueryDto extends AdminPaginationQuery {
  @ApiPropertyOptional({ description: 'Matches username, email or display name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: ROLE_SLUGS, description: 'Role slug, not id — slugs are stable across environments' })
  @IsOptional()
  @IsIn(ROLE_SLUGS as unknown as string[])
  role?: string;

  @ApiPropertyOptional({ enum: ['newest', 'xp', 'plays', 'username'], default: 'newest' })
  @IsOptional()
  @IsIn(['newest', 'xp', 'plays', 'username'])
  sort?: 'newest' | 'xp' | 'plays' | 'username';
}

export class AdminUpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  displayName?: string;

  @ApiPropertyOptional({ description: 'Changing an email is checked for uniqueness before it is written' })
  @IsOptional()
  @IsString()
  @MaxLength(190)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  bio?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: ROLE_SLUGS })
  @IsOptional()
  @IsIn(ROLE_SLUGS as unknown as string[])
  role?: string;

  @ApiPropertyOptional({ description: 'Manual XP adjustment (support refunds, event prizes). Levels are recomputed.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  xp?: number;

  @ApiPropertyOptional({ description: 'Revoke every session, forcing a re-login on all devices' })
  @IsOptional()
  // JSON booleans and form-encoded "true"/"1" both arrive here; `@Type(() => Boolean)`
  // would turn the string "false" into true, so the coercion is explicit.
  @Transform(({ value }) => value === true || value === 'true' || value === 1 || value === '1')
  @IsBoolean()
  revokeSessions?: boolean;
}

export class BanUserDto {
  @ApiPropertyOptional({ description: 'Stored in the activity log and shown to the user on their next sign-in attempt' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
