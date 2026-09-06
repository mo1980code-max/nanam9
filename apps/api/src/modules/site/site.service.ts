/**
 * Site configuration: settings, homepage sections, themes, redirects, activity log.
 *
 * FOUR DECISIONS SHAPE THIS MODULE:
 *
 * 1. A SETTING IS TYPED, AND THE TYPE IS ENFORCED ON WRITE AND ON READ. `type`
 *    ('number' | 'boolean' | 'html' | …) coerces the stored JSON and rejects a value
 *    that cannot be coerced. Without this the admin form saves `"12"` for a number
 *    setting and the frontend computes `"12" + 1 === "121"` — a bug that survives
 *    review because every layer "worked".
 *
 * 2. SECRETS CANNOT BE MADE PUBLIC. A key matching `secret|token|password|apikey|…`
 *    is refused `isPublic: true`, and `publicSettings()` filters those keys again on
 *    the way out. Two independent checks for one irreversible mistake: a leaked API
 *    key cannot be un-leaked by reverting a commit. Their values are also redacted
 *    *before* they reach the audit log, because the log is exported, backed up and
 *    rendered in the admin UI.
 *
 * 3. `html` VALUES ARE SANITISED ON WRITE — except under the `integrations.`
 *    namespace, whose entire purpose is to execute (analytics, ad tags). Those are
 *    the only keys allowed scripts, they still require `settings.manage`, and the
 *    distinction is documented at both ends rather than implied.
 *
 * 4. PUBLIC READS ARE CACHED, WRITES INVALIDATE. Settings are read on every page
 *    render and written a few times a day, which is the textbook case for a cache —
 *    and the textbook case for a stale cache. Every write deletes both scopes, so the
 *    worst case is one extra query, never a wrong value. Without Redis the same code
 *    path degrades to the in-process map inside RedisService.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ActivityLogRow, Database, RedirectRow, SectionRow, SettingRow, ThemeRow } from '@voltade/db';
import { CACHE, SETTINGS_CATALOGUE, findUnsafeHtml, safeUrl, sanitizeHtml } from '@voltade/shared';
import { AuditService } from '../../common/audit/audit.service.js';
import { DATABASE } from '../../common/database/database.module.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { AppError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { absoluteUrl } from '../../common/http/urls.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import type {
  ActivityQueryDto,
  RedirectQueryDto,
  ReorderSectionsDto,
  SectionsQueryDto,
  SettingsQueryDto,
  UpsertRedirectDto,
  UpsertSectionDto,
  UpsertSettingDto,
  UpsertThemeDto,
} from './dto/site.dto.js';

/** Anything a credential would be called. Checked on write and again on read. */
const SECRET_KEY = /(secret|token|passw|credential|api[_-]?key|private[_-]?key|signature|salt|dsn|webhook)/i;

/** Keys whose value is code by definition. Only these may carry scripts. */
const VERBATIM_PREFIX = 'integrations.';

const MAX_HTML_LENGTH = 200_000;
const MAX_STRING_LENGTH = 5_000;

/**
 * Factory state comes from the shared catalogue, so the seeder, this API and the
 * admin UI all agree on which keys exist and what they mean.
 */
const SETTING_DEFAULTS = SETTINGS_CATALOGUE;

export type PublicSettings = Record<string, unknown>;

export type SettingView = {
  key: string;
  value: unknown;
  type: string;
  group: string;
  isPublic: boolean;
  description: string | null;
  /** False while the value still comes from the factory defaults. */
  stored: boolean;
  updatedAt: string | null;
};

export type SectionView = {
  id: string;
  page: string;
  kind: string;
  title: string | null;
  titleEn: string | null;
  subtitle: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
  isVisible: boolean;
};

export type ThemeView = {
  slug: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  previewUrl: string | null;
};

export type RedirectResolution = {
  found: boolean;
  sourcePath: string;
  targetPath: string | null;
  /** Absolute URL when the target is on this site’s host. */
  absoluteTarget: string | null;
  statusCode: number | null;
};

/**
 * Per-key outcome of a settings save. `code` and `status` carry the original error
 * through, so saving one setting can answer `setting.secret_public` (a policy
 * refusal) rather than a generic "rejected" — the admin UI shows different help
 * text for each, and the frontend must not have to parse the message to tell them
 * apart.
 */
export type BulkSettingResult = { key: string; ok: boolean; error?: string; code?: string; status?: number };

@Injectable()
export class SiteService {
  private readonly logger = new Logger('site');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // ── settings ─────────────────────────────────────────────────────────────

  /**
   * The flat map a page shell renders from: `settings['site.name']`.
   *
   * A map rather than an array because a layout reads a dozen keys per render and
   * `items.find(i => i.key === …)` a dozen times is how a fast page becomes slow.
   */
  async publicSettings(): Promise<PublicSettings> {
    const cacheKey = CACHE.key.settings('public');
    const cached = await this.redis.getJson<PublicSettings>(cacheKey);
    if (cached) return cached;

    const rows = await this.db.operations.getSettings({ publicOnly: true });
    const stored = new Map(rows.map((row) => [row.key, row]));
    const out: PublicSettings = {};

    for (const [key, fallback] of Object.entries(SETTING_DEFAULTS)) {
      if (!fallback.isPublic) continue;
      const row = stored.get(key);
      // Second secret filter: `isPublic` is an admin-toggled column, and a mistake
      // there must not be enough to publish a credential.
      if (SECRET_KEY.test(key)) continue;
      out[key] = row ? this.coerceForRead(row) : fallback.value;
    }
    for (const row of rows) {
      if (SECRET_KEY.test(row.key)) continue;
      if (!row.isPublic) continue;
      out[row.key] = this.coerceForRead(row);
    }

    await this.redis.setJson(cacheKey, out, CACHE.ttl.settings);
    return out;
  }

  /** Every setting, defaults included, for the admin form and the setup wizard. */
  async allSettings(query: SettingsQueryDto = {}): Promise<SettingView[]> {
    const cacheKey = CACHE.key.settings('all');
    // The group filter is applied after the cache read rather than cached per group:
    // there are a handful of groups and one cache entry to invalidate is worth more
    // than five.
    if (!query.group) {
      const cached = await this.redis.getJson<SettingView[]>(cacheKey);
      if (cached) return cached;
    }

    const rows = await this.db.operations.getSettings();
    const views: SettingView[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.key);
      views.push(this.view(row, true));
    }
    for (const [key, fallback] of Object.entries(SETTING_DEFAULTS)) {
      if (seen.has(key)) continue;
      views.push({
        key,
        value: fallback.value,
        type: fallback.type,
        group: fallback.group,
        isPublic: fallback.isPublic,
        description: fallback.description,
        stored: false,
        updatedAt: null,
      });
    }

    views.sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
    await this.redis.setJson(cacheKey, views, CACHE.ttl.settings);
    return query.group ? views.filter((v) => v.group === query.group) : views;
  }

  async setting(key: string): Promise<SettingView> {
    const row = await this.db.operations.getSetting(key);
    if (row) return this.view(row, true);
    const fallback = SETTING_DEFAULTS[key];
    if (!fallback) throw new AppError('setting.not_found', `no setting with the key "${key}"`, 404);
    return { key, value: fallback.value, type: fallback.type, group: fallback.group, isPublic: fallback.isPublic, description: fallback.description, stored: false, updatedAt: null };
  }

  async setOne(meta: RequestMeta, dto: UpsertSettingDto): Promise<SettingView> {
    const result = await this.setMany(meta, [dto]);
    const first = result.results[0];
    // Re-throw with the real code and status instead of flattening every failure
    // into one generic 400.
    if (!first?.ok) throw new AppError(first?.code ?? 'setting.rejected', first?.error ?? 'setting rejected', first?.status ?? 400);
    return this.setting(dto.key);
  }

  /**
   * Write many settings at once.
   *
   * Per-key results instead of all-or-nothing: a settings screen has thirty fields
   * and one bad colour code should not throw away the other twenty-nine. The audit
   * line is single, because "saved the SEO tab" is the event an admin remembers.
   */
  async setMany(meta: RequestMeta, settings: UpsertSettingDto[]): Promise<{ updated: number; rejected: number; results: BulkSettingResult[] }> {
    const results: BulkSettingResult[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const dto of settings) {
      try {
        const existing = await this.db.operations.getSetting(dto.key);
        const type = dto.type ?? existing?.type ?? SETTING_DEFAULTS[dto.key]?.type ?? 'string';
        const group = dto.group ?? existing?.group ?? SETTING_DEFAULTS[dto.key]?.group ?? dto.key.split('.')[0]!;
        const isPublic = dto.isPublic ?? existing?.isPublic ?? SETTING_DEFAULTS[dto.key]?.isPublic ?? false;

        if (isPublic && SECRET_KEY.test(dto.key)) {
          throw new AppError('setting.secret_public', `"${dto.key}" looks like a credential and can never be public`, 400);
        }

        const value = this.coerceForWrite(dto.key, dto.value, type);
        before[dto.key] = existing ? redactSecret(dto.key, this.coerceForRead(existing)) : null;
        after[dto.key] = redactSecret(dto.key, value);

        await this.db.operations.setSetting({
          key: dto.key,
          value,
          type,
          group,
          isPublic,
          description: dto.description ?? existing?.description ?? SETTING_DEFAULTS[dto.key]?.description ?? null,
        });
        results.push({ key: dto.key, ok: true });
      } catch (error) {
        const message = error instanceof AppError ? error.message : error instanceof Error ? error.message : 'rejected';
        results.push({
          key: dto.key,
          ok: false,
          error: message,
          code: error instanceof AppError ? error.code : 'setting.rejected',
          status: error instanceof AppError ? error.statusCode : 400,
        });
      }
    }

    const updated = results.filter((r) => r.ok).length;
    if (updated > 0) {
      await this.redis.del(CACHE.key.settings('public'), CACHE.key.settings('all'));
      this.audit.recordChange(meta, {
        action: updated === 1 ? 'setting.update' : 'settings.bulk_update',
        targetKind: 'setting',
        targetId: updated === 1 ? results.find((r) => r.ok)?.key ?? null : null,
        before,
        after,
      });
      this.logger.log(`${updated} setting(s) updated by ${meta.actorLabel ?? 'system'}`);
    }
    return { updated, rejected: results.length - updated, results };
  }

  async remove(meta: RequestMeta, key: string): Promise<{ deleted: boolean; revertedToDefault: boolean }> {
    const row = await this.db.operations.getSetting(key);
    const deleted = row ? await this.db.operations.deleteSetting(key) : false;
    await this.redis.del(CACHE.key.settings('public'), CACHE.key.settings('all'));
    if (deleted) {
      this.audit.record(meta, {
        action: 'setting.delete',
        targetKind: 'setting',
        targetId: key,
        after: { value: redactSecret(key, row?.value ?? null) },
      });
    }
    // Deleting a setting that has a factory default is a revert, not a removal —
    // the admin UI has to say which one happened.
    return { deleted, revertedToDefault: key in SETTING_DEFAULTS };
  }

  // ── homepage sections (the drag-and-drop builder) ────────────────────────

  async sections(query: SectionsQueryDto = {}, options: { includeHidden?: boolean } = {}): Promise<SectionView[]> {
    const page = query.page ?? 'home';
    const cacheKey = CACHE.key.sections(page);
    if (!options.includeHidden) {
      const cached = await this.redis.getJson<SectionView[]>(cacheKey);
      if (cached) return cached;
    }

    const rows = await this.db.operations.listSections(page);
    const views = rows
      .filter((row) => options.includeHidden || row.isVisible)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => this.section(row));

    if (!options.includeHidden) await this.redis.setJson(cacheKey, views, CACHE.ttl.sections);
    return views;
  }

  /** Localised heading: the web app renders one locale per request. */
  private section(row: SectionRow): SectionView {
    return {
      id: row.id,
      page: row.page,
      kind: row.kind,
      title: row.title,
      titleEn: row.titleEn,
      subtitle: row.subtitle,
      config: row.config ?? {},
      sortOrder: row.sortOrder,
      isVisible: row.isVisible,
    };
  }

  async upsertSection(meta: RequestMeta, dto: UpsertSectionDto): Promise<SectionView> {
    const page = dto.page ?? 'home';
    const existing = dto.id ? (await this.db.operations.listSections(page)).find((row) => row.id === dto.id) ?? null : null;
    if (dto.id && !existing) throw new AppError('section.not_found', `no section with id ${dto.id} on page "${page}"`, 404);

    // Appended sections go to the end instead of position 0: a new block that jumps
    // above the hero is the kind of surprise that makes editors stop trusting the
    // builder.
    const siblings = await this.db.operations.listSections(page);
    const sortOrder = dto.sortOrder ?? (existing?.sortOrder ?? (siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0));

    const row = await this.db.operations.upsertSection({
      ...(existing?.id ? { id: existing.id } : {}),
      page,
      kind: dto.kind,
      title: dto.title ?? existing?.title ?? null,
      titleEn: dto.titleEn ?? existing?.titleEn ?? null,
      subtitle: dto.subtitle ?? existing?.subtitle ?? null,
      config: dto.config ?? existing?.config ?? {},
      sortOrder,
      isVisible: dto.isVisible ?? existing?.isVisible ?? true,
    });

    await this.redis.del(CACHE.key.sections(page));
    this.audit.recordChange(meta, {
      action: existing ? 'section.update' : 'section.create',
      targetKind: 'section',
      targetId: row.id,
      before: existing ? this.section(existing) : {},
      after: this.section(row),
    });
    return this.section(row);
  }

  async reorderSections(meta: RequestMeta, dto: ReorderSectionsDto): Promise<{ reordered: number; page: string }> {
    const rows = await this.db.operations.listSections(dto.page);
    const known = new Set(rows.map((r) => r.id));
    const ordered = dto.ids.filter((id) => known.has(id));
    if (ordered.length !== dto.ids.length) {
      const unknown = dto.ids.filter((id) => !known.has(id));
      throw new AppError('section.not_found', `unknown section id(s) on page "${dto.page}": ${unknown.join(', ')}`, 404);
    }
    await this.db.operations.reorderSections(dto.page, ordered);
    await this.redis.del(CACHE.key.sections(dto.page));
    this.audit.record(meta, { action: 'section.reorder', targetKind: 'section', targetId: dto.page, after: { order: ordered } });
    return { reordered: ordered.length, page: dto.page };
  }

  async removeSection(meta: RequestMeta, id: string): Promise<{ deleted: boolean }> {
    let page = 'home';
    let found: SectionRow | null = null;
    // Sections are addressed by id but cached per page, so the page has to be
    // discovered to invalidate the right key.
    for (const candidate of ['home', 'category', 'game', 'blog']) {
      const row = (await this.db.operations.listSections(candidate)).find((r) => r.id === id);
      if (row) {
        found = row;
        page = candidate;
        break;
      }
    }
    if (!found) throw new AppError('section.not_found', `no section with id ${id}`, 404);

    const deleted = await this.db.operations.deleteSection(id);
    await this.redis.del(CACHE.key.sections(page));
    this.audit.record(meta, { action: 'section.delete', targetKind: 'section', targetId: id, before: this.section(found) });
    return { deleted };
  }

  // ── themes ───────────────────────────────────────────────────────────────

  async themes(): Promise<ThemeView[]> {
    const cached = await this.redis.getJson<ThemeView[]>(CACHE.key.theme('all'));
    if (cached) return cached;
    const rows = await this.db.operations.listThemes();
    const views = rows.map((row) => this.theme(row));
    await this.redis.setJson(CACHE.key.theme('all'), views, CACHE.ttl.theme);
    return views;
  }

  async activeTheme(): Promise<ThemeView | null> {
    const cached = await this.redis.getJson<ThemeView>(CACHE.key.theme('active'));
    if (cached) return cached;
    const row = await this.db.operations.activeTheme();
    if (!row) return null;
    const view = this.theme(row);
    await this.redis.setJson(CACHE.key.theme('active'), view, CACHE.ttl.theme);
    return view;
  }

  private theme(row: ThemeRow): ThemeView {
    return {
      slug: row.slug,
      name: row.name,
      isActive: row.isActive,
      isDefault: row.isDefault,
      config: row.config ?? {},
      previewUrl: row.previewUrl,
    };
  }

  async upsertTheme(meta: RequestMeta, dto: UpsertThemeDto): Promise<ThemeView> {
    const row = await this.db.operations.upsertTheme({
      slug: dto.slug,
      name: dto.name,
      config: dto.config ?? {},
      previewUrl: dto.previewUrl ?? null,
      ...(dto.isDefault === undefined ? {} : { isDefault: dto.isDefault }),
    });
    if (dto.isDefault) await this.db.operations.setDefaultTheme(dto.slug);
    await this.invalidateThemes();
    this.audit.recordChange(meta, { action: 'theme.upsert', targetKind: 'theme', targetId: row.slug, before: {}, after: this.theme(row) });
    return this.theme(row);
  }

  /**
   * Activate a theme for everybody, or set the default a first-time visitor gets.
   *
   * Exactly one theme is active: `setDefaultTheme` clears the others in the same
   * statement, so two replicas cannot each leave a different theme switched on.
   */
  async activateTheme(meta: RequestMeta, slug: string, options: { asDefault?: boolean } = {}): Promise<ThemeView> {
    const ok = await this.db.operations.setDefaultTheme(slug);
    if (!ok) throw new AppError('theme.not_found', `no theme with the slug "${slug}"`, 404);
    await this.invalidateThemes();
    this.audit.record(meta, { action: options.asDefault ? 'theme.set_default' : 'theme.activate', targetKind: 'theme', targetId: slug });
    const active = await this.activeTheme();
    if (!active) throw new AppError('theme.not_found', `no theme with the slug "${slug}"`, 404);
    return active;
  }

  private async invalidateThemes(): Promise<void> {
    await this.redis.del(CACHE.key.theme('active'), CACHE.key.theme('all'));
  }

  // ── redirects ────────────────────────────────────────────────────────────

  /**
   * Resolve a legacy path. The web app's middleware calls this before rendering a
   * 404, so a slug change never costs an inbound link.
   */
  async resolveRedirect(query: RedirectQueryDto): Promise<RedirectResolution> {
    const path = normalizePath(query.path);
    const row = await this.db.operations.findRedirect(path);
    if (!row) return { found: false, sourcePath: path, targetPath: null, absoluteTarget: null, statusCode: null };

    // Counting the hit is not allowed to delay or break the redirect itself.
    void this.db.operations.trackRedirectHit(row.id).catch((error: unknown) => {
      this.logger.warn(`redirect hit counter failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    });

    const target = row.targetPath;
    return {
      found: true,
      sourcePath: path,
      targetPath: target,
      absoluteTarget: target.startsWith('/') ? absoluteUrl(target, this.config.APP_URL) : target,
      statusCode: row.statusCode,
    };
  }

  async redirects(pageArg?: { page: number; perPage: number; offset: number }): Promise<{ items: RedirectRow[]; total: number }> {
    return this.db.operations.listRedirects(pageArg);
  }

  async upsertRedirect(meta: RequestMeta, dto: UpsertRedirectDto): Promise<RedirectRow> {
    const source = normalizePath(dto.sourcePath);
    const target = this.assertRedirectTarget(dto.targetPath);
    if (source === normalizePath(target)) {
      throw new AppError('redirect.loop', `"/${source}" cannot redirect to itself`, 400);
    }
    const row = await this.db.operations.upsertRedirect({ sourcePath: source, targetPath: target, statusCode: dto.statusCode ?? 301 });
    this.audit.recordChange(meta, {
      action: 'redirect.upsert',
      targetKind: 'redirect',
      targetId: source,
      before: {},
      after: { sourcePath: row.sourcePath, targetPath: row.targetPath, statusCode: row.statusCode },
    });
    return row;
  }

  /**
   * A redirect target is either a path on this site or an absolute URL on this
   * site's host. Anything else is an open redirect, which turns a trusted domain
   * into a phishing launcher (`voltade.test/r?url=evil`) — and search engines
   * penalise the domain for it too.
   */
  private assertRedirectTarget(target: string): string {
    if (target.startsWith('/')) {
      if (target.includes('//') || target.includes('\\') || target.includes('..')) {
        throw new AppError('redirect.invalid_target', 'target paths must be plain relative paths', 400);
      }
      return target;
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new AppError('redirect.invalid_target', 'target must start with / or be an absolute URL', 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('redirect.invalid_target', `unsupported protocol "${url.protocol}"`, 400);
    }
    const allowed = new URL(this.config.APP_URL).host;
    if (url.host !== allowed) {
      throw new AppError('redirect.external_host', `external redirects are limited to "${allowed}"`, 400);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  async removeRedirect(meta: RequestMeta, id: string): Promise<{ deleted: boolean }> {
    const row = await this.db.operations.listRedirects({ page: 1, perPage: 500, offset: 0 });
    const found = row.items.find((r) => r.id === id);
    if (!found) throw new AppError('redirect.not_found', `no redirect with id ${id}`, 404);
    const deleted = await this.db.operations.deleteRedirect(id);
    this.audit.record(meta, { action: 'redirect.delete', targetKind: 'redirect', targetId: found.sourcePath, before: { targetPath: found.targetPath } });
    return { deleted };
  }

  // ── activity log ─────────────────────────────────────────────────────────

  async activity(query: ActivityQueryDto): Promise<{ items: ActivityView[]; total: number }> {
    const result = await this.db.operations.listActivity({
      action: query.action,
      actorId: query.actor,
      page: query.pageArg,
    });
    return { items: result.items.map(activityView), total: result.total };
  }

  // ── setting value handling ───────────────────────────────────────────────

  /**
   * Validate and normalise on the way in. Everything that can be rejected is
   * rejected here, so a read never has to defend itself.
   */
  private coerceForWrite(key: string, value: unknown, type: string): unknown {
    const invalid = (detail: string): never => {
      throw new AppError('setting.invalid_value', `"${key}" expects ${type}: ${detail}`, 400);
    };

    switch (type) {
      case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n)) return invalid('a finite number');
        return n;
      }
      case 'boolean': {
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 1 || value === '1') return true;
        if (value === 'false' || value === 0 || value === '0') return false;
        return invalid('true or false');
      }
      case 'json': {
        if (value === null || typeof value !== 'object') return invalid('an object or array');
        return value;
      }
      case 'color': {
        if (typeof value !== 'string') return invalid('a hex colour');
        const hex = value.trim();
        if (!/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return invalid('a hex colour like #7c3aed');
        return hex.toLowerCase();
      }
      case 'image': {
        if (typeof value !== 'string' || value.length === 0) return invalid('an image path or URL');
        if (value.startsWith('/')) return value;
        const url = safeUrl(value, 'img', 'src');
        if (!url) return invalid('an http(s) URL or a path starting with /');
        return url;
      }
      case 'html': {
        if (typeof value !== 'string') return invalid('a string of HTML');
        if (value.length > MAX_HTML_LENGTH) return invalid(`at most ${MAX_HTML_LENGTH} characters`);
        // Verbatim only for the integration namespace: analytics and ad tags whose
        // purpose is to execute. Everywhere else the value is an editor's rich text
        // and gets cleaned, so a pasted `<script>` cannot become stored XSS.
        const allowScripts = key.startsWith(VERBATIM_PREFIX);
        const clean = sanitizeHtml(value, { allowScripts, maxLength: MAX_HTML_LENGTH });
        const findings = findUnsafeHtml(value);
        if (!allowScripts && findings.length > 0) {
          this.logger.debug(`setting ${key}: stripped ${findings.map((f) => f.reason).join(', ')}`);
        }
        return clean;
      }
      default: {
        if (value === null) return null;
        if (typeof value === 'object') return invalid('a plain string');
        const text = String(value);
        if (text.length > MAX_STRING_LENGTH) return invalid(`at most ${MAX_STRING_LENGTH} characters`);
        return text;
      }
    }
  }

  /** Values are stored as JSON, so a number setting is already a number — but a row
   *  written before its type was declared may not be, and a read must not throw. */
  private coerceForRead(row: SettingRow): unknown {
    try {
      return this.coerceForWrite(row.key, row.value, row.type);
    } catch {
      return row.value;
    }
  }

  private view(row: SettingRow, stored: boolean): SettingView {
    return {
      key: row.key,
      // Never hand a secret value to a client that can read the settings list: the
      // admin form shows a placeholder and keeps the stored value on an empty submit.
      value: SECRET_KEY.test(row.key) ? '••••' : this.coerceForRead(row),
      type: row.type,
      group: row.group,
      isPublic: row.isPublic,
      description: row.description,
      stored,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ''),
    };
  }
}

export type ActivityView = {
  id: number;
  action: string;
  actor: { id: string | null; label: string | null };
  targetKind: string | null;
  targetId: string | null;
  ip: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};

function activityView(row: ActivityLogRow): ActivityView {
  return {
    id: row.id,
    action: row.action,
    actor: { id: row.actorId, label: row.actorLabel },
    targetKind: row.targetKind,
    targetId: row.targetId,
    ip: row.ip,
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

function normalizePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

/** Replaces a credential's value with a placeholder before it can be persisted. */
export function redactSecret(key: string, value: unknown): unknown {
  return SECRET_KEY.test(key) ? '••••' : value;
}

export { SETTING_DEFAULTS, SECRET_KEY };
