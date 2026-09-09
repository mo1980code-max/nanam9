/**
 * Moderation DTOs. They extend the public DTOs so the admin queue and the public
 * thread list cannot drift apart in shape — the same service builds both, only the
 * visibility rules differ.
 */

import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import type { CommentStatus } from '@voltade/shared';
import { CommentsQueryDto } from './social.dto.js';

/** The queue accepts the same filters as the public list; `status` defaults to
 *  `pending` when omitted, and `any` means "no status filter". */
export class CommentsQueueQueryDto extends CommentsQueryDto {}

export class BulkModerateDto {
  @ApiProperty({ type: [String], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  ids!: string[];

  @ApiProperty({ enum: ['visible', 'hidden', 'spam', 'deleted'] })
  @IsIn(['visible', 'hidden', 'spam', 'deleted'])
  status!: CommentStatus;
}
