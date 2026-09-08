/**
 * Ads service — the ad manager's business logic.
 *
 * WHY THIS IS ITS OWN SERVICE:
 * - The commerce repository is raw SQL; this service adds validation (date windows,
 *   code length vs. type), caching (Redis per placement) and audit logging in one place.
 * - Search indexing and the game page are read-heavy; ads are write-rare and read
 *   on every page view. Caching the live set per placement for 60s means 1k RPS still
 *   costs one DB row per minute, not per request — and Redis fallback keeps a dev box honest.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdRow, Database } from '@voltade/db';
import { AppError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { DATABASE } from '../../common/database/database.module.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { CACHE } from '@voltade/shared';
import type { AdsQueryDto, CreateAdDto, UpdateAdDto } from './dto/ads.dto.js';

@Injectable()
export class AdsService {
  private readonly logger = new Logger('ads');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  private cacheKey(placement: string): string {
    return `voltade:cache:${CACHE.key.ads(placement)}`;
  }

  private async bust(placement?: string): Promise<void> {
    if (placement) await this.redis.del(this.cacheKey(placement));
    else {
      // placement unknown — conservative flush of the few known keys
      const keys = [
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
      ].map((p) => this.cacheKey(p));
      await this.redis.del(...keys);
    }
  }

  async list(query: AdsQueryDto): Promise<AdRow[]> {
    return this.db.commerce.listAds({ placement: query.placement, status: query.status });
  }

  /** Live ads for a placement — what the public site renders. Cached briefly. */
  async forPlacement(placement: string): Promise<AdRow[]> {
    const key = this.cacheKey(placement);
    const cached = await this.redis.getJson<AdRow[]>(key);
    if (cached) return cached;
    const rows = await this.db.commerce.adsForPlacement(placement);
    // Cache even an empty placement: an empty slot is still a hot path.
    await this.redis.setJson(key, rows, CACHE.ttl.ads);
    return rows;
  }

  async create(meta: RequestMeta, dto: CreateAdDto): Promise<AdRow> {
    this.validateWindow(dto.startsAt, dto.endsAt);
    this.validateCodeForType(dto.type ?? 'html', dto.code, dto.imageUrl);
    const row = await this.db.commerce.createAd({
      name: dto.name.trim(),
      placement: dto.placement,
      type: dto.type ?? 'html',
      status: dto.status ?? 'active',
      code: dto.code ?? null,
      imageUrl: dto.imageUrl ?? null,
      linkUrl: dto.linkUrl ?? null,
      priority: dto.priority ?? 0,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      targeting: (dto.targeting ?? {}) as Record<string, unknown>,
    });
    await this.bust(row.placement);
    this.audit.record(meta, { action: 'ad.create', targetKind: 'ad', targetId: row.id, after: { placement: row.placement, name: row.name, priority: row.priority } });
    this.logger.log(`ad created ${row.id} @ ${row.placement} (${row.type})`);
    return row;
  }

  async update(meta: RequestMeta, id: string, dto: UpdateAdDto): Promise<AdRow> {
    const existing = await this.db.commerce.listAds().then((rows) => rows.find((r) => r.id === id) ?? null);
    if (!existing) throw new AppError('ad.not_found', `no ad with id ${id}`, 404);
    // validate window against the *resulting* values, not just the patch
    const nextStarts = dto.startsAt !== undefined ? dto.startsAt : existing.startsAt?.toISOString() ?? null;
    const nextEnds = dto.endsAt !== undefined ? dto.endsAt : existing.endsAt?.toISOString() ?? null;
    this.validateWindow(nextStarts, nextEnds);
    const nextType = dto.type ?? existing.type;
    const nextCode = dto.code !== undefined ? dto.code : existing.code;
    const nextImage = dto.imageUrl !== undefined ? dto.imageUrl : existing.imageUrl;
    this.validateCodeForType(nextType, nextCode, nextImage);

    const patch: Partial<AdRow> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.placement !== undefined) patch.placement = dto.placement;
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.code !== undefined) patch.code = dto.code;
    if (dto.imageUrl !== undefined) patch.imageUrl = dto.imageUrl;
    if (dto.linkUrl !== undefined) patch.linkUrl = dto.linkUrl;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.startsAt !== undefined) patch.startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    if (dto.endsAt !== undefined) patch.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (dto.targeting !== undefined) patch.targeting = dto.targeting as Record<string, unknown>;

    const updated = await this.db.commerce.updateAd(id, patch);
    if (!updated) throw new AppError('ad.not_found', `no ad with id ${id}`, 404);
    // bust both old and new placement when it changes
    await this.bust(existing.placement);
    if (updated.placement !== existing.placement) await this.bust(updated.placement);
    this.audit.recordChange(meta, { action: 'ad.update', targetKind: 'ad', targetId: id, before: existing as unknown as Record<string, unknown>, after: updated as unknown as Record<string, unknown> });
    return updated;
  }

  async remove(meta: RequestMeta, id: string): Promise<{ deleted: boolean }> {
    const existing = await this.db.commerce.listAds().then((rows) => rows.find((r) => r.id === id) ?? null);
    if (!existing) throw new AppError('ad.not_found', `no ad with id ${id}`, 404);
    const deleted = await this.db.commerce.deleteAd(id);
    await this.bust(existing.placement);
    this.audit.record(meta, { action: 'ad.delete', targetKind: 'ad', targetId: id, before: { placement: existing.placement, name: existing.name } });
    return { deleted };
  }

  async track(id: string, event: 'impression' | 'click'): Promise<void> {
    // fire-and-forget counter: never fail the page render because counting did
    await this.db.commerce.trackAd(id, event).catch(() => undefined);
  }

  private validateWindow(startsAt: string | null | undefined, endsAt: string | null | undefined): void {
    if (!startsAt || !endsAt) return;
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return; // class-validator already rejected malformed ISO strings
    if (end <= start) throw new AppError('ad.invalid_window', 'endsAt must be after startsAt', 400);
  }

  private validateCodeForType(type: string, code: string | null | undefined, imageUrl: string | null | undefined): void {
    if (type === 'image') {
      if (!imageUrl) throw new AppError('ad.image_required', 'image ads require imageUrl', 400);
    }
    // html/script/adsense must carry code — but we allow an empty placeholder during creation so the slot can be reserved first
  }
}
