/**
 * Query DTOs shared by the list endpoints.
 *
 * class-validator + the global ValidationPipe (`whitelist: true, transform: true`)
 * means an unknown query parameter is stripped rather than reaching a repository,
 * and `?page=abc` becomes a 400 with the field name instead of a NaN offset that
 * would make PostgreSQL error out mid-query.
 */

import { Type } from 'class-transformer';
import { IsBooleanString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GAME_SORTS, PAGINATION } from '@voltade/shared';

export class PaginationQuery {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION.maxPerPage, default: PAGINATION.defaultPerPage })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION.maxPerPage)
  perPage = PAGINATION.defaultPerPage;

  /** The database pager wants a precomputed offset; DTOs stay declarative. */
  get offset(): number {
    return (this.page - 1) * this.perPage;
  }

  get pageArg(): { page: number; perPage: number; offset: number } {
    return { page: this.page, perPage: this.perPage, offset: this.offset };
  }
}

export class GameListQuery extends PaginationQuery {
  @ApiPropertyOptional({ description: 'free-text search over title, description and tags (Arabic + English)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ description: 'category slug, including children' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({ description: 'tag slug' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tag?: string;

  @ApiPropertyOptional({ enum: GAME_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(GAME_SORTS as unknown as string[])
  sort?: string;

  @ApiPropertyOptional({ description: 'only featured games' })
  @IsOptional()
  @IsBooleanString()
  featured?: string;

  @ApiPropertyOptional({ description: 'only premium (or only free) games' })
  @IsOptional()
  @IsBooleanString()
  premium?: string;

  @ApiPropertyOptional({ description: 'age rating filter: everyone | everyone_10 | teen | mature' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  ageRating?: string;

  @ApiPropertyOptional({ description: "'ar' or 'en' — decides which title the search vector prefers" })
  @IsOptional()
  @IsIn(['ar', 'en'])
  locale?: string;
}

export class CommentListQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: ['newest', 'oldest', 'top'], default: 'newest' })
  @IsOptional()
  @IsIn(['newest', 'oldest', 'top'])
  sort?: 'newest' | 'oldest' | 'top';

  @ApiPropertyOptional({ description: 'include replies as a nested tree (default true)' })
  @IsOptional()
  @IsBooleanString()
  tree?: string;
}
