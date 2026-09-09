/**
 * /api/admin/games — the catalogue back office.
 *
 * Permissions are declared per route, not per controller: an Editor should be able
 * to create and edit games (`games.create`, `games.update`) without being able to
 * hard-delete one (`games.delete` + the admin role). Declaring the rule next to the
 * handler is what makes that auditable by reading one file.
 *
 * Static routes (`upload`, `bulk`, `recount`) are declared BEFORE `:id` for the same
 * reason as in the public controller: `/admin/games/upload` is a valid `:id`.
 *
 * Uploads stream into memory with a hard size cap rather than into a temp directory:
 * the archive has to be parsed before it is stored anyway, and a temp file that a
 * crashed worker leaves behind is a disk-fill vector nobody monitors.
 */

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors, HttpCode, HttpStatus } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { memoryStorage } from 'multer';
import { ROLE_LEVELS } from '@voltade/shared';
import { CurrentUser, Permissions, RateLimit, type RequestUser } from '../../common/decorators/index.js';
import { AppError } from '../../common/http/errors.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { AdminGameListQueryDto, BulkGameActionDto, CreateGameDto, ReorderDto, UpdateGameDto, UploadQueryDto } from './dto/game.dto.js';
import { GamesService } from './games.service.js';
import { UploadService } from './upload.service.js';
import { ZIP_LIMITS } from './zip.js';

const ARCHIVE_LIMITS = { fileSize: ZIP_LIMITS.maxArchiveBytes };
const IMAGE_LIMITS = { fileSize: 12 * 1024 * 1024 };

const fileBody = (description: string) => ({
  schema: { type: 'object', properties: { file: { type: 'string', format: 'binary', description } } },
});

@ApiTags('admin · games')
@Controller('admin/games')
export class GamesAdminController {
  constructor(private readonly games: GamesService, private readonly uploads: UploadService) {}

  // ── collection ───────────────────────────────────────────────────────────

  @Get()
  @Permissions('games.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Admin listing: drafts, pending and archived games included' })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'pending', 'published', 'scheduled', 'archived', 'any'] })
  @ApiQuery({ name: 'includeDeleted', required: false, enum: ['1', '0'] })
  async list(@Req() req: Request, @Query() query: AdminGameListQueryDto) {
    const result = await this.games.adminList(requestMeta(req), query);
    return { items: result.items, total: result.total };
  }

  @Post()
  @Permissions('games.create')
  @RateLimit('write')
  @ApiOperation({ summary: 'Create a game (draft by default; publish with status or the publish route)' })
  @ApiResponse({ status: 201, description: 'Game created' })
  @ApiResponse({ status: 409, description: 'Slug already taken and could not be made unique' })
  async create(@Req() req: Request, @Body() dto: CreateGameDto) {
    return this.games.create(requestMeta(req), dto);
  }

  @Post('upload')
  @Permissions('games.upload')
  @RateLimit('write')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: ARCHIVE_LIMITS }))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody('HTML5 game archive (.zip) containing index.html'))
  @ApiOperation({ summary: 'Upload a game ZIP: validated, unpacked, stored, optionally turned into a draft' })
  @ApiResponse({ status: 201, description: 'Archive stored; the playable URL is in `entryPointUrl`' })
  @ApiResponse({ status: 400, description: 'Not a ZIP, no index.html, or an entry escapes the archive' })
  @ApiResponse({ status: 409, description: 'An identical archive is already in the catalogue (duplicate hash)' })
  async upload(@Req() req: Request, @UploadedFile() file: Express.Multer.File | undefined, @Query() query: UploadQueryDto) {
    if (!file) throw new AppError('upload.missing_file', 'send the archive in a "file" field of a multipart/form-data request', 400);
    const meta = requestMeta(req);
    const manifest = await this.uploads.storeArchive({ buffer: file.buffer, originalName: file.originalname });
    if (manifest.duplicateOf) {
      // 409 with the existing game: the editor needs to know *which* game matched,
      // not just that something did. This is the manual-upload half of duplicate
      // detection; provider imports use the same `source_hash` column.
      throw new AppError('upload.duplicate', `an identical archive is already published as "${manifest.duplicateOf.title}"`, 409, {
        details: { existing: manifest.duplicateOf, sourceHash: manifest.sourceHash },
      });
    }
    if (!query.wantsDraft) return manifest;

    // The draft is created through GamesService so slug generation, uniqueness and
    // the audit trail are the same as for any other game — never a second code path.
    const game = await this.games.create(meta, {
      title: manifest.title,
      titleEn: manifest.title,
      slug: query.slug,
      url: manifest.entryPointUrl,
      filePath: `${manifest.key}/${manifest.entryPointPath}`,
      kind: 'html5_zip', // a self-hosted build, not a third-party iframe
      status: 'draft',
      ageRating: 'everyone',
      orientation: 'any',
      width: manifest.dimensions?.width ?? undefined,
      height: manifest.dimensions?.height ?? undefined,
      sizeKb: manifest.sizeKb,
      meta: {
        sourceHash: manifest.sourceHash,
        originalName: file.originalname,
        files: manifest.files,
        bytes: manifest.totalBytes,
        warnings: manifest.warnings,
        uploadedBy: meta.actorId ?? null,
      },
    });
    return { ...manifest, game: { id: game.id, slug: game.slug, title: game.title, status: game.status } };
  }

  @Post('upload/image')
  @Permissions('games.upload')
  @RateLimit('write')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: IMAGE_LIMITS }))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody('PNG, JPEG, WebP, GIF or AVIF artwork'))
  @ApiOperation({ summary: 'Upload artwork (thumbnail, banner, gallery image)' })
  @ApiResponse({ status: 201, description: 'Stored; the public URL is returned' })
  @ApiResponse({ status: 415, description: 'Unsupported type — SVG is rejected by design' })
  async uploadImage(@Req() req: Request, @UploadedFile() file: Express.Multer.File | undefined, @Query('kind') kind?: string) {
    if (!file) throw new AppError('upload.missing_file', 'send the image in a "file" field of a multipart/form-data request', 400);
    void req;
    const allowed = ['thumbnail', 'banner', 'avatar', 'gallery'] as const;
    const use = (allowed as readonly string[]).includes(kind ?? '') ? (kind as (typeof allowed)[number]) : 'gallery';
    return this.uploads.storeImage({ buffer: file.buffer, originalName: file.originalname, kind: use });
  }

  @Post('bulk')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @Permissions('games.update')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Publish, unpublish or archive many games in one call' })
  async bulk(@Req() req: Request, @Body() dto: BulkGameActionDto) {
    return this.games.bulkStatus(requestMeta(req), dto);
  }

  @Post('recount')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @Permissions('games.update')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Re-derive denormalised counters for every game (drift repair)' })
  async recountAll(@Req() req: Request) {
    return this.games.recount(requestMeta(req));
  }

  @Post('reorder/:categorySlug')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @Permissions('games.feature')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Persist a manual ordering inside one category (drag-and-drop grid)' })
  @ApiParam({ name: 'categorySlug' })
  async reorder(@Req() req: Request, @Param('categorySlug') categorySlug: string, @Body() dto: ReorderDto) {
    // Homepage sections are a different thing (pages/sections, owned by the CMS
    // module); this endpoint orders the games *inside a category*, which is what
    // category_game.position exists for.
    return this.games.reorderGames(requestMeta(req), categorySlug, dto.ids);
  }

  // ── single game ──────────────────────────────────────────────────────────

  @Get(':id')
  @Permissions('games.view')
  @RateLimit('admin')
  @ApiOperation({ summary: 'One game as stored, including drafts and internals' })
  @ApiParam({ name: 'id', description: 'Game id (not the slug)' })
  async one(@Req() req: Request, @Param('id') id: string) {
    return this.games.adminOne(requestMeta(req), id);
  }

  @Patch(':id')
  @Permissions('games.update')
  @RateLimit('write')
  @ApiOperation({ summary: 'Update a game. Publishing stamps published_at and clears noindex.' })
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateGameDto) {
    return this.games.update(requestMeta(req), id, dto);
  }

  @Post(':id/restore')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @Permissions('games.update')
  @RateLimit('write')
  @ApiOperation({ summary: 'Restore a soft-deleted game' })
  async restore(@Req() req: Request, @Param('id') id: string) {
    return this.games.restore(requestMeta(req), id);
  }

  @Post(':id/recount')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @Permissions('games.update')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Re-derive one game’s counters from likes, ratings, comments and favourites' })
  async recount(@Req() req: Request, @Param('id') id: string) {
    return this.games.recount(requestMeta(req), id);
  }

  @Delete(':id')
  @Permissions('games.delete')
  @RateLimit('write')
  @ApiOperation({ summary: 'Archive a game (soft delete). ?hard=1 erases it and needs the admin role.' })
  @ApiQuery({ name: 'hard', required: false, enum: ['1', '0'], description: 'Permanently delete the row' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Unknown game' })
  async remove(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: RequestUser | null, @Query('hard') hard?: string) {
    const wantsHard = hard === '1' || hard === 'true';
    if (wantsHard && (user?.role.level ?? 0) < ROLE_LEVELS.admin) {
      // A hard delete destroys the slug, the analytics and every comment thread
      // attached to it. That is an owner-level decision, not an editor one — so it
      // is gated on role level, not just on holding `games.delete`.
      throw new AppError('games.hard_delete_forbidden', 'only an administrator can permanently delete a game', 403);
    }
    return this.games.remove(requestMeta(req), id, { hard: wantsHard });
  }
}
