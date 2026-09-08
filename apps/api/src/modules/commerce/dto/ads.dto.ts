/**
 * Ads DTOs — the ad manager's contract.
 *
 * Two invariants shape this file:
 * 1. `placement` + `status` are the indexed path (ads_placement_status_priority_idx)
 *    so every filter the UI actually needs is an index scan, never a full scan.
 * 2. `code` is opaque HTML/JS. The API stores it verbatim and the web app renders it
 *    inside a sandboxed container — no sanitisation here that would break AdSense
 *    snippets, but a 20 000-character ceiling to keep a single row from becoming a payload bomb.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const AD_PLACEMENTS = [
  'header',
  'header_bottom',
  'sidebar_top',
  'sidebar_bottom',
  'in_feed',
  'interstitial',
  'footer',
  'game_top',
  'game_side',
  'game_bottom',
  'blog_post',
  'preloader',
] as const;

export const AD_TYPES = ['html', 'adsense', 'google_ad_manager', 'prebid', 'image', 'script'] as const;

export const AD_STATUSES = ['active', 'paused', 'scheduled', 'expired', 'archived'] as const;

export class AdsQueryDto {
  @ApiPropertyOptional({ enum: AD_PLACEMENTS, description: 'Filter by placement slot' })
  @IsOptional()
  @IsIn(AD_PLACEMENTS as unknown as string[])
  placement?: string;

  @ApiPropertyOptional({ enum: AD_STATUSES, description: 'Filter by status' })
  @IsOptional()
  @IsIn(AD_STATUSES as unknown as string[])
  status?: string;
}

export class CreateAdDto {
  @ApiProperty({ description: 'Admin label — never shown to visitors', example: 'Header banner 728×90' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: AD_PLACEMENTS, description: 'Where the slot is rendered' })
  @IsIn(AD_PLACEMENTS as unknown as string[])
  placement!: string;

  @ApiPropertyOptional({ enum: AD_TYPES, default: 'html' })
  @IsOptional()
  @IsIn(AD_TYPES as unknown as string[])
  type?: string;

  @ApiPropertyOptional({ enum: AD_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(AD_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ description: 'Raw HTML/JS for html/script/adsense slots', maxLength: 20_000 })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  code?: string | null;

  @ApiPropertyOptional({ description: 'Image URL for image ads', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Destination URL when the image is clicked', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  linkUrl?: string | null;

  @ApiPropertyOptional({ description: 'Higher priority wins within the same placement', minimum: 0, maximum: 1000, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({ description: 'ISO date — ad is invisible before this timestamp' })
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiPropertyOptional({ description: 'ISO date — ad is invisible after this timestamp' })
  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @ApiPropertyOptional({ description: 'Targeting rules as JSON (categories, countries, loggedOutOnly…)', type: Object })
  @IsOptional()
  @IsObject()
  targeting?: Record<string, unknown>;
}

export class UpdateAdDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: AD_PLACEMENTS })
  @IsOptional()
  @IsIn(AD_PLACEMENTS as unknown as string[])
  placement?: string;

  @ApiPropertyOptional({ enum: AD_TYPES })
  @IsOptional()
  @IsIn(AD_TYPES as unknown as string[])
  type?: string;

  @ApiPropertyOptional({ enum: AD_STATUSES })
  @IsOptional()
  @IsIn(AD_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ maxLength: 20_000 })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  code?: string | null;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string | null;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  linkUrl?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  targeting?: Record<string, unknown>;
}
