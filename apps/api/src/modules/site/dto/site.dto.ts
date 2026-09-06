/**
 * Site DTOs — settings, homepage sections, themes, redirects and the activity log.
 *
 * TWO RULES SHAPE THIS FILE:
 *
 * 1. Every enum comes from @voltade/shared (which mirrors the PostgreSQL enums and
 *    the web app's switch statements). A DTO that accepts a value the database or
 *    the renderer does not understand turns validation into a 500-generator.
 *
 * 2. `UpsertSettingDto.value` is deliberately untyped at the DTO layer and typed at
 *    the service layer by the setting's own `type` field. A JSON body can carry a
 *    string, a number, an object or a boolean, and class-validator cannot express
 *    "whatever this key's declared type is" — so the DTO only guarantees the value
 *    is *present* (`@Allow()` keeps it through the whitelist pipe) and the service
 *    coerces and rejects it against the declared type.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SectionKind, SettingType } from '@voltade/shared';
import { Allow, ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AdminPaginationQuery, PaginationQuery } from '../../../common/dto/pagination.dto.js';

const SETTING_TYPES = Object.values(SettingType);
const SECTION_KINDS = Object.values(SectionKind);

/**
 * A setting key is a dotted namespace: `site.name`, `seo.defaultTitle`,
 * `integrations.headHtml`. The FIRST segment is the group, which is why the admin
 * screen can build its tabs from the keys themselves instead of a second table.
 */
const SETTING_KEY = /^[a-z][a-z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){1,3}$/;

/** Theme and section slugs end up in URLs and in `localStorage`, so they stay ASCII. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

export class UpsertSettingDto {
  @ApiProperty({ description: 'Dotted key — the first segment is the group', example: 'site.name' })
  @IsString()
  @Matches(SETTING_KEY, { message: 'setting keys look like site.name or seo.defaultTitle' })
  @MaxLength(80)
  key!: string;

  @ApiProperty({ description: 'Any JSON value. The setting’s `type` decides how it is validated and read back.' })
  // @Allow (not @IsDefined) because `null` is a legitimate value — it means "unset"
  // — and because the real check is type-aware and happens in the service.
  @Allow()
  value!: unknown;

  @ApiPropertyOptional({ enum: SETTING_TYPES, default: 'string', description: 'Drives coercion on read and validation on write' })
  @IsOptional()
  @IsIn(SETTING_TYPES as unknown as string[])
  type?: string;

  @ApiPropertyOptional({ description: 'Admin grouping; defaults to the key’s first segment', example: 'seo' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  group?: string;

  @ApiPropertyOptional({ default: false, description: 'Public settings are served to anonymous visitors by GET /api/settings' })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional({ description: 'Shown as help text in the admin form' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class UpsertSettingsDto {
  @ApiProperty({
    type: [UpsertSettingDto],
    description: 'Up to 50 settings in one call: one audit line, one cache flush, one page save',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UpsertSettingDto)
  settings!: UpsertSettingDto[];
}

export class SettingsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by group (`seo`, `ads`, …)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  group?: string;
}

export class UpsertSectionDto {
  @ApiPropertyOptional({ description: 'Existing section id — present means "update in place"', example: 'clx…' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  id?: string;

  @ApiPropertyOptional({ description: 'Page key: home, category, game, blog — or any custom page slug', default: 'home' })
  @IsOptional()
  @IsString()
  @Matches(SLUG, { message: 'page keys are lowercase slugs' })
  @MaxLength(40)
  page?: string;

  @ApiProperty({ enum: SECTION_KINDS, description: 'Which renderer the web app picks' })
  @IsIn(SECTION_KINDS as unknown as string[])
  kind!: string;

  @ApiPropertyOptional({ description: 'Arabic heading (the default locale)' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  title?: string;

  @ApiPropertyOptional({ description: 'English heading — falls back to `title` when absent' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  titleEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(220)
  subtitle?: string;

  @ApiPropertyOptional({
    description: 'Section data: { "category": "racing", "limit": 12, "sort": "popular" }',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 0, maximum: 999, description: 'Position in the page; reorder persists the drag-and-drop result' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true, description: 'Hidden sections stay configured but are not rendered' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}

export class ReorderSectionsDto {
  @ApiProperty({ description: 'Page whose sections are reordered', example: 'home' })
  @IsString()
  @Matches(SLUG)
  @MaxLength(40)
  page!: string;

  @ApiProperty({ type: [String], description: 'Every visible section id, in the new order' })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  ids!: string[];
}

export class SectionsQueryDto {
  @ApiPropertyOptional({ description: 'Page key', default: 'home' })
  @IsOptional()
  @IsString()
  @Matches(SLUG)
  @MaxLength(40)
  page?: string;
}

export class UpsertThemeDto {
  @ApiProperty({ description: 'Theme slug — appears in the theme switcher and in the `voltade_theme` cookie', example: 'neon-dark' })
  @IsString()
  @Matches(SLUG, { message: 'theme slugs are lowercase, hyphenated' })
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ description: 'Design tokens: { "accent": "#7c3aed", "radius": 14 }', type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  previewUrl?: string;

  @ApiPropertyOptional({ default: false, description: 'The default is what a first-time visitor gets' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpsertRedirectDto {
  @ApiProperty({ description: 'Legacy path, starting with /', example: '/games/old-slug' })
  @IsString()
  @Matches(/^\//, { message: 'source paths start with /' })
  @MaxLength(500)
  sourcePath!: string;

  @ApiProperty({ description: 'Relative path, or an absolute URL on this site’s host', example: '/game/new-slug' })
  @IsString()
  @MaxLength(500)
  targetPath!: string;

  @ApiPropertyOptional({ enum: [301, 302, 307, 308], default: 301, description: '301 for permanent moves (SEO transfers), 302 for temporary ones' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([301, 302, 307, 308])
  statusCode?: number;
}

export class RedirectQueryDto {
  @ApiProperty({ description: 'Path to resolve, exactly as requested', example: '/games/old-slug' })
  @IsString()
  @Matches(/^\//, { message: 'path must start with /' })
  @MaxLength(500)
  path!: string;
}

export class ActivityQueryDto extends AdminPaginationQuery {
  @ApiPropertyOptional({ description: 'Exact action, e.g. `game.update`' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @ApiPropertyOptional({ description: 'Actor user id' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  actor?: string;
}
