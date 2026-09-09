/**
 * Game DTOs.
 *
 * The public list query EXTENDS the shared `GameListQuery` instead of restating it:
 * page/perPage/q/category/tag/sort/featured/premium/ageRating are already validated
 * there, and a second copy is how two endpoints end up disagreeing about what
 * `?sort=popular` means.
 *
 * Admin DTOs are strict about everything, because a typo'd field there means a game
 * published with the wrong age rating.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AGE_RATINGS,
  GAME_KINDS,
  GAME_STATUSES,
  GAME_SORTS,
  GameOrientation,
  type AgeRating,
  type GameKind,
  type GameStatus,
} from '@voltade/shared';
import type { GameListFilter } from '@voltade/db';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { GameListQuery } from '../../../common/dto/pagination.dto.js';

/*
 * The enum value lists are imported from @voltade/shared, which mirrors the
 * PostgreSQL enums created in migration 0001. Hardcoding them here is how an API
 * ends up accepting `kind: "html5"` and then failing with
 * `invalid input value for enum game_kind` at INSERT time — a 500 caused by a
 * value the DTO promised was valid.
 */
const ORIENTATIONS = Object.values(GameOrientation);

export type GameSort = (typeof GAME_SORTS)[number];
export { type AgeRating, type GameKind, type GameStatus };

const toBool = (value?: string): boolean | undefined => {
  if (value === undefined || value === '') return undefined;
  return value === '1' || value === 'true';
};

const asSort = (value?: string): GameSort | undefined =>
  value && (GAME_SORTS as readonly string[]).includes(value) ? (value as GameSort) : undefined;

export class GameListQueryDto extends GameListQuery {
  @ApiPropertyOptional({ description: 'Comma-separated category slugs (OR) — powers "action + racing" rails' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  categories?: string;

  @ApiPropertyOptional({ enum: GAME_KINDS, description: 'Engine/technology filter' })
  @IsOptional()
  @IsIn(GAME_KINDS as unknown as string[])
  kind?: GameKind;

  @ApiPropertyOptional({ description: 'Game id to exclude — a related rail must not contain the game it sits under' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  exclude?: string;

  /** Normalised into the repository's filter object; the DTO stays declarative. */
  toFilter(): GameListFilter {
    return {
      sort: asSort(this.sort),
      q: this.q?.trim() || undefined,
      categorySlug: this.category?.trim() || undefined,
      categorySlugs: this.categories
        ? this.categories.split(',').map((slug) => slug.trim()).filter(Boolean).slice(0, 12)
        : undefined,
      tagSlug: this.tag?.trim() || undefined,
      featured: toBool(this.featured),
      premium: toBool(this.premium),
      ageRating: this.ageRating || undefined,
      kind: this.kind,
      locale: this.locale,
      excludeId: this.exclude || undefined,
      page: this.pageArg,
    };
  }
}

export class AdminGameListQueryDto extends GameListQueryDto {
  @ApiPropertyOptional({ enum: [...GAME_STATUSES, 'any'], description: "'any' removes the status filter" })
  @IsOptional()
  @IsIn([...GAME_STATUSES, 'any'] as unknown as string[])
  status?: GameStatus | 'any';

  @ApiPropertyOptional({ enum: ['1', '0', 'true', 'false'], description: 'Include soft-deleted games' })
  @IsOptional()
  @IsBooleanString()
  includeDeleted?: string;

  get wantsDeleted(): boolean {
    return this.includeDeleted === '1' || this.includeDeleted === 'true';
  }
}

export class PlayEventDto {
  @ApiProperty({ description: 'Game slug or id' })
  @IsString()
  @MaxLength(120)
  game!: string;

  @ApiPropertyOptional({ description: 'Anonymous visitor id (the voltade_sid cookie) — lets guests get "continue playing"' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  sessionId?: string;

  @ApiPropertyOptional({ enum: ['desktop', 'mobile', 'tablet', 'tv', 'other', 'unknown'] })
  @IsOptional()
  @IsIn(['desktop', 'mobile', 'tablet', 'tv', 'other', 'unknown'])
  device?: string;

  @ApiPropertyOptional({ description: 'Seconds played, reported by the game frame' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  durationSeconds?: number;

  @ApiPropertyOptional({ description: 'The player finished the game (drives completion-rate analytics)' })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @ApiPropertyOptional({ description: 'UTM source, kept for the traffic report' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmSource?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmMedium?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmCampaign?: string;
}

export class GameSeoDto {
  @ApiPropertyOptional({ maxLength: 180 })
  @IsOptional()
  @IsString()
  @MaxLength(180)
  title?: string;

  @ApiPropertyOptional({ maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  keywords?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  canonical?: string;

  @ApiPropertyOptional({ description: 'Keep the game out of the index (drafts default to true)' })
  @IsOptional()
  @IsBoolean()
  noindex?: boolean;
}

export class CreateGameDto {
  @ApiProperty({ description: 'Arabic title (primary)' })
  @IsString()
  @MaxLength(180)
  title!: string;

  @ApiPropertyOptional({ description: 'English title' })
  @IsOptional()
  @IsString()
  @MaxLength(180)
  titleEn?: string;

  @ApiPropertyOptional({ description: 'URL slug; generated from the title when omitted, de-duplicated automatically' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) descriptionEn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) developer?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) version?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1970) @Max(2100) releaseYear?: number;

  @ApiProperty({ description: 'Playable URL, or the entryPointUrl returned by the ZIP upload endpoint' })
  @IsString()
  @MaxLength(1200)
  url!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) filePath?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) thumbnailUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) bannerUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(1200, { each: true }) gallery?: string[];

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) width?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) height?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) sizeKb?: number;

  @ApiPropertyOptional({ enum: GAME_KINDS, default: 'iframe' })
  @IsOptional() @IsIn(GAME_KINDS as unknown as string[]) kind?: GameKind;

  @ApiPropertyOptional({ enum: ORIENTATIONS, default: 'any' })
  @IsOptional() @IsIn(ORIENTATIONS as unknown as string[]) orientation?: (typeof ORIENTATIONS)[number];

  @ApiPropertyOptional({ enum: AGE_RATINGS, default: 'everyone' })
  @IsOptional() @IsIn(AGE_RATINGS as unknown as string[]) ageRating?: AgeRating;

  @ApiPropertyOptional({ enum: GAME_STATUSES, default: 'draft' })
  @IsOptional() @IsIn(GAME_STATUSES as unknown as string[]) status?: GameStatus;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() featured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() premium?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Category slugs; created when missing so an import cannot fail on taxonomy' })
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(90, { each: true }) categories?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Tag slugs; created when missing' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) tags?: string[];

  @ApiPropertyOptional({ type: GameSeoDto })
  @IsOptional() @ValidateNested() @Type(() => GameSeoDto) seo?: GameSeoDto;

  @ApiPropertyOptional({ description: 'Free-form provider payload, kept so a re-sync can diff it' })
  @IsOptional()
  meta?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Publish at this moment instead of immediately (ISO 8601)' })
  @IsOptional() @IsString() @MaxLength(40) publishedAt?: string;
}

export class UpdateGameDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(180) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(180) titleEn?: string;
  @ApiPropertyOptional({ description: 'Changing the slug writes a 301 redirect from the old one' })
  @IsOptional() @IsString() @MaxLength(120) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) descriptionEn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) developer?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) version?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1970) @Max(2100) releaseYear?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) filePath?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) thumbnailUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1200) bannerUrl?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) gallery?: string[];
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) width?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) height?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) sizeKb?: number;
  @ApiPropertyOptional({ enum: GAME_KINDS }) @IsOptional() @IsIn(GAME_KINDS as unknown as string[]) kind?: GameKind;
  @ApiPropertyOptional({ enum: ORIENTATIONS }) @IsOptional() @IsIn(ORIENTATIONS as unknown as string[]) orientation?: (typeof ORIENTATIONS)[number];
  @ApiPropertyOptional({ enum: AGE_RATINGS }) @IsOptional() @IsIn(AGE_RATINGS as unknown as string[]) ageRating?: AgeRating;
  @ApiPropertyOptional({ enum: GAME_STATUSES }) @IsOptional() @IsIn(GAME_STATUSES as unknown as string[]) status?: GameStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() featured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() premium?: boolean;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) categories?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional({ type: GameSeoDto })
  @IsOptional() @ValidateNested() @Type(() => GameSeoDto) seo?: GameSeoDto;
  @ApiPropertyOptional() @IsOptional() meta?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) publishedAt?: string;
}

export class BulkGameActionDto {
  @ApiProperty({ type: [String], description: 'Game ids' })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids!: string[];

  @ApiPropertyOptional({ enum: GAME_STATUSES, description: 'Target status; defaults to published' })
  @IsOptional()
  @IsIn(GAME_STATUSES as unknown as string[])
  status?: GameStatus;
}

export class ReorderDto {
  @ApiProperty({ type: [String], description: 'Game ids in the desired order' })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids!: string[];
}

export class UploadQueryDto {
  @ApiPropertyOptional({ description: 'Slug for the draft that is created; generated from the file name when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;

  @ApiPropertyOptional({ enum: ['1', '0', 'true', 'false'], description: 'Create a draft game from the archive' })
  @IsOptional()
  @IsBooleanString()
  create?: string;

  get wantsDraft(): boolean {
    return this.create === '1' || this.create === 'true';
  }
}

export class LimitQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 48, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  limit = 12;
}

/** Exposed so clients and OpenAPI can never disagree with the database CHECKs. */
export const GAME_ORIENTATIONS = ORIENTATIONS;
