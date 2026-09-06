/**
 * Taxonomy DTOs — nested categories and multi-tags.
 *
 * `parentId` is accepted as a SLUG, not an id: the admin panel's category form and
 * an import script both know "racing" and neither should have to look up an
 * internal identifier first. Slugs are also stable across environments, so a
 * category export/import round-trip does not need an id map.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQuery } from '../../../common/dto/pagination.dto.js';

export class CategoryQueryDto extends PaginationQuery {
  @ApiPropertyOptional({ description: 'Return the nested tree instead of a flat list' })
  @IsOptional()
  @IsIn(['1', '0', 'true', 'false'])
  tree?: string;

  @ApiPropertyOptional({ description: 'Include hidden categories (staff only)' })
  @IsOptional()
  @IsIn(['1', '0', 'true', 'false'])
  all?: string;

  get wantsTree(): boolean {
    return this.tree !== '0' && this.tree !== 'false';
  }

  get wantsAll(): boolean {
    return this.all === '1' || this.all === 'true';
  }
}

export class CreateCategoryDto {
  @ApiProperty({ description: 'Arabic name (primary)' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @ApiPropertyOptional({ description: 'URL slug; generated from the name when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(90)
  slug?: string;

  @ApiPropertyOptional({ description: 'Parent category slug — nesting is unlimited' })
  @IsOptional()
  @IsString()
  @MaxLength(90)
  parent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Icon name or URL used by the category tiles' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Hex accent colour for the tile' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(180) seoTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) seoDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) seoKeywords?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) canonicalUrl?: string;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameEn?: string;
  @ApiPropertyOptional({ description: 'Changing the slug writes a 301 from the old category URL' })
  @IsOptional() @IsString() @MaxLength(90) slug?: string;
  @ApiPropertyOptional({ description: "New parent slug, or 'null' to move to the root" })
  @IsOptional() @IsString() @MaxLength(90) parent?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) thumbnailUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) color?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(180) seoTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) seoDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) seoKeywords?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) canonicalUrl?: string;
}

export class ReorderCategoriesDto {
  @ApiProperty({ type: [String], description: 'Category ids in the desired order' })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  ids!: string[];
}

export class TagQueryDto {
  @ApiPropertyOptional({ description: 'Partial name/slug match — the tag autocomplete' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ enum: ['game', 'blog'], default: 'game' })
  @IsOptional()
  @IsIn(['game', 'blog'])
  scope?: 'game' | 'blog';

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 60;
}

export class UpsertTagsDto {
  @ApiProperty({ type: [String], description: 'Tag names or slugs; created when missing' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags!: string[];

  @ApiPropertyOptional({ enum: ['game', 'blog'], default: 'game' })
  @IsOptional()
  @IsIn(['game', 'blog'])
  scope?: 'game' | 'blog';
}

export class SuggestQueryDto {
  @ApiProperty({ description: 'What the visitor has typed so far' })
  @IsString()
  @MaxLength(80)
  q!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit = 5;
}
