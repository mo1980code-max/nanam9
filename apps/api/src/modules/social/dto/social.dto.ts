/**
 * Social DTOs — comments, votes, ratings, favourites, playlists and reports.
 *
 * Enum values are imported from @voltade/shared, which mirrors the PostgreSQL enums:
 * a DTO that accepts a value the database rejects turns a validation layer into a
 * 500-generator.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentStatus, PlaylistVisibility, ReportReason, ReportStatus, TARGET_KINDS, TargetKind } from '@voltade/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CommentListQuery, AdminPaginationQuery, PaginationQuery } from '../../../common/dto/pagination.dto.js';

const COMMENT_STATUSES = Object.values(CommentStatus);
const VISIBILITIES = Object.values(PlaylistVisibility);
const REASONS = Object.values(ReportReason);
const REPORT_STATUSES = Object.values(ReportStatus);

/** Star reviews for one game — paged, because a popular game has thousands. */
export class RatingsQueryDto extends PaginationQuery {
  @ApiProperty({ description: 'Game slug or id whose reviews are listed' })
  @IsString()
  @MaxLength(120)
  game!: string;
}

export class CommentsQueryDto extends CommentListQuery {
  @ApiPropertyOptional({ description: 'Game slug — comments under a game' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  game?: string;

  @ApiPropertyOptional({ description: 'Blog post slug — comments under an article' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  post?: string;

  @ApiPropertyOptional({ description: 'Comment id, to page through one thread’s replies' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  parent?: string;

  @ApiPropertyOptional({ enum: COMMENT_STATUSES, description: 'Moderation queues only; the public sees `visible`' })
  @IsOptional()
  @IsIn(COMMENT_STATUSES as unknown as string[])
  status?: string;
}

export class CreateCommentDto {
  @ApiPropertyOptional({ description: 'Game slug (or use `post`)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  game?: string;

  @ApiPropertyOptional({ description: 'Blog post slug (or use `game`)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  post?: string;

  @ApiPropertyOptional({ description: 'Parent comment id — replies nest up to MAX_DEPTH' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  parent?: string;

  @ApiProperty({ minLength: 2, maxLength: 2000 })
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional({ description: 'Guest comments only; ignored for signed-in users' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  authorName?: string;

  @ApiPropertyOptional({ description: 'Guest comments only — stored hashed, never shown' })
  @IsOptional()
  @IsEmail()
  @MaxLength(180)
  authorEmail?: string;
}

export class UpdateCommentDto {
  @ApiProperty({ minLength: 2, maxLength: 2000 })
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  body!: string;
}

export class VoteDto {
  @ApiProperty({ enum: [TargetKind.game, TargetKind.comment] })
  @IsIn([TargetKind.game, TargetKind.comment] as unknown as string[])
  target!: 'game' | 'comment';

  @ApiProperty({ description: 'Game id/slug or comment id' })
  @IsString()
  @MaxLength(120)
  targetId!: string;

  @ApiProperty({ enum: [1, -1, 0], description: '1 = like, -1 = dislike, 0 = withdraw the vote' })
  @Type(() => Number)
  @IsInt()
  @IsIn([1, -1, 0])
  value!: 1 | -1 | 0;
}

export class RateDto {
  @ApiProperty({ description: 'Game slug or id' })
  @IsString()
  @MaxLength(120)
  game!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Shown as a review and indexed for Schema.org Review' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  review?: string;
}

export class GameRefDto {
  @ApiProperty({ description: 'Game slug or id' })
  @IsString()
  @MaxLength(120)
  game!: string;
}

export class CreatePlaylistDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'URL slug; generated from the name when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(90)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: VISIBILITIES, default: 'public', description: 'public = listed and shareable, unlisted = shareable by link only' })
  @IsOptional()
  @IsIn(VISIBILITIES as unknown as string[])
  visibility?: (typeof VISIBILITIES)[number];

  @ApiPropertyOptional({ type: [String], description: 'Game slugs/ids to add immediately' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  games?: string[];
}

export class UpdatePlaylistDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(90) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional({ enum: VISIBILITIES }) @IsOptional() @IsIn(VISIBILITIES as unknown as string[]) visibility?: (typeof VISIBILITIES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) coverUrl?: string;
}

export class PlaylistGameDto {
  @ApiProperty({ description: 'Game slug or id' })
  @IsString()
  @MaxLength(120)
  game!: string;

  @ApiPropertyOptional({ description: 'Explicit position; appended when omitted' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;
}

export class PlaylistGamesBulkDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  games!: string[];
}

export class ReportDto {
  @ApiProperty({ enum: TARGET_KINDS })
  @IsIn(TARGET_KINDS as unknown as string[])
  targetKind!: string;

  @ApiProperty({ description: 'Id (or slug, for games) of the reported thing' })
  @IsString()
  @MaxLength(120)
  targetId!: string;

  @ApiProperty({ enum: REASONS })
  @IsIn(REASONS as unknown as string[])
  reason!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}

export class ModerateCommentDto {
  @ApiProperty({ enum: COMMENT_STATUSES })
  @IsIn(COMMENT_STATUSES as unknown as string[])
  status!: string;
}

export class ResolveReportDto {
  @ApiProperty({ enum: REPORT_STATUSES })
  @IsIn(REPORT_STATUSES as unknown as string[])
  status!: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'What was done — shown to the reporter' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolution?: string;
}

export class ReportsQueryDto extends AdminPaginationQuery {
  @ApiPropertyOptional({ enum: [...REPORT_STATUSES, 'any'] })
  @IsOptional()
  @IsIn([...REPORT_STATUSES, 'any'] as unknown as string[])
  status?: string;
}

export const MAX_COMMENT_DEPTH = 5;
export const GUEST_COMMENTS_ALLOWED = true;
