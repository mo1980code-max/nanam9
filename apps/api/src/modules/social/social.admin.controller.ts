/**
 * /api/admin/comments and /api/admin/reports — the moderation queue.
 *
 * Moderation lives in its own controller for two reasons: a moderator-only route
 * must never be reachable through a mis-set `@Public()` flag on a user endpoint,
 * and the queue exposes fields (hidden bodies, report details, author identities)
 * that the public comment shape must not carry.
 *
 * Bulk actions return per-id results, because a moderation batch that fails
 * silently on 12 of 50 items is worse than one that reports the failures.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Permissions, type RequestUser } from '../../common/decorators/index.js';
import { AppError, UnauthorizedError } from '../../common/http/errors.js';
import { requestMeta } from '../../common/http/request-meta.js';
import { BulkModerateDto, CommentsQueueQueryDto } from './dto/social.admin.dto.js';
// VALUE imports — never `import type`, and never `import { type X }`: both erase the
// class, TypeScript then emits `design:paramtypes = Function` for that parameter,
// Nest's ValidationPipe "validates" a bare Function (no decorators to run) and
// `plainToInstance(Function, body)` drops every field. The handler receives `{}` and
// the request silently does nothing while returning 200.
// test/controller-dto-imports.spec.ts fails the build if this regresses.
import { ModerateCommentDto, ReportsQueryDto, ResolveReportDto } from './dto/social.dto.js';
import { SocialService } from './social.service.js';

@ApiTags('admin: moderation')
@Controller('admin')
export class SocialAdminController {
  constructor(private readonly social: SocialService) {}

  @Get('comments')
  @Permissions('comments.view')
  @ApiOperation({ summary: 'Moderation queue — pending by default, or hidden/spam/visible/any' })
  @ApiResponse({ status: 200, description: 'Flat, paginated list of comments in the requested state' })
  @ApiResponse({ status: 403, description: 'No comments.view permission' })
  async queue(@Req() req: Request, @Query() query: CommentsQueueQueryDto, @CurrentUser() user: RequestUser | null) {
    // Default the queue to un-approved comments and flatten the tree: a moderator
    // pages through individual items, they do not read threads.
    query.status = query.status ?? 'pending';
    query.tree = '0';
    const result = await this.social.comments(requestMeta(req), query, moderator(user));
    return { items: result.items, total: result.total };
  }

  @Post('comments/:id/moderate')
  @HttpCode(200)
  @Permissions('comments.moderate')
  @ApiOperation({ summary: 'Approve, hide, mark as spam or restore a comment' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'The new status' })
  @ApiResponse({ status: 403, description: 'No comments.moderate permission' })
  async moderate(@Req() req: Request, @Param('id') id: string, @Body() dto: ModerateCommentDto) {
    return this.social.moderateComment(requestMeta(req), id, dto);
  }

  @Post('comments/bulk-moderate')
  @HttpCode(200)
  @Permissions('comments.moderate')
  @ApiOperation({ summary: 'Apply one status to up to 100 comments (queue triage)' })
  @ApiResponse({ status: 200, description: 'Per-id results, including failures' })
  async bulkModerate(@Req() req: Request, @Body() dto: BulkModerateDto) {
    const meta = requestMeta(req);
    const results: { id: string; ok: boolean; status?: string; error?: string }[] = [];
    for (const id of dto.ids) {
      try {
        const updated = await this.social.moderateComment(meta, id, { status: dto.status });
        results.push({ id, ok: true, status: updated.status });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof AppError ? error.message : 'failed' });
      }
    }
    return { updated: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results };
  }

  @Delete('comments/:id')
  @Permissions('comments.delete')
  @ApiOperation({ summary: 'Hard-delete a comment — for illegal content, not for tidying' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Removed' })
  async remove(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: RequestUser | null, @Query('hard') hard?: string) {
    return this.social.deleteComment(requestMeta(req), id, moderator(user), { hard: hard !== '0' });
  }

  @Get('reports')
  @Permissions('reports.view')
  @ApiOperation({ summary: 'User reports, filtered by status (open first)' })
  @ApiResponse({ status: 200, description: 'Reports with reporter and moderator names resolved' })
  async reports(@Req() req: Request, @Query() query: ReportsQueryDto) {
    const result = await this.social.reports(requestMeta(req), query);
    return { items: result.items, total: result.total };
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  @Permissions('reports.resolve')
  @ApiOperation({ summary: 'Close a report as action_taken or dismissed, with a note for the reporter' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'The resolved report' })
  @ApiResponse({ status: 403, description: 'No reports.moderate permission' })
  async resolve(@Req() req: Request, @Param('id') id: string, @Body() dto: ResolveReportDto, @CurrentUser() user: RequestUser | null) {
    return this.social.resolveReport(requestMeta(req), id, dto, moderator(user));
  }
}

/** The PermissionsGuard already proved there is an authorised user; this narrows
 *  the type for the service and keeps the 401 honest if the guard order changes. */
function moderator(user: RequestUser | null): RequestUser {
  if (!user) throw new UnauthorizedError('session', 'sign in to continue');
  return user;
}
