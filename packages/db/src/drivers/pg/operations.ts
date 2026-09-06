/**
 * SQL driver — operations: settings, page-builder sections, themes, redirects,
 * activity log, provider import bookkeeping, releases and backups.
 *
 * Settings are one JSON row per key with an `is_public` flag: the API serves
 * `/settings/public` straight from that flag, so "can the browser see this?" is a
 * property of the data, not of a route somebody has to remember to filter.
 */

import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type {
  ActivityLogRow,
  BackupRow,
  ID,
  ImportJobRow,
  List,
  OperationsRepository,
  ProviderItemRow,
  ProviderRow,
  RedirectRow,
  ReleaseRow,
  SectionRow,
  SettingRow,
  ThemeRow,
} from '../../ports.js';
import { PgRepo, eq, newId, pageOf, toColumns } from './helpers.js';

export class PgOperationsRepository extends PgRepo implements OperationsRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  // ─────────────────────────────── settings ───────────────────────────────

  async getSettings(options: { publicOnly?: boolean } = {}): Promise<SettingRow[]> {
    return this.conn.many<SettingRow>(
      `SELECT * FROM settings ${options.publicOnly ? 'WHERE is_public = true' : ''} ORDER BY "group", key`,
    );
  }

  async getSetting(key: string): Promise<SettingRow | null> {
    return this.conn.one<SettingRow>(`SELECT * FROM settings WHERE key = $1`, [key]);
  }

  async setSetting(input: {
    key: string;
    value: unknown;
    type?: string;
    group?: string;
    isPublic?: boolean;
    description?: string | null;
  }): Promise<SettingRow> {
    const row = await this.conn.one<SettingRow>(
      `INSERT INTO settings (key, value, type, "group", is_public, description, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, type = EXCLUDED.type, "group" = EXCLUDED."group",
             is_public = EXCLUDED.is_public,
             description = coalesce(EXCLUDED.description, settings.description),
             updated_at = now()
       RETURNING *`,
      [
        input.key,
        JSON.stringify(input.value ?? null),
        input.type ?? 'string',
        input.group ?? 'general',
        input.isPublic ?? false,
        input.description ?? null,
      ],
    );
    if (!row) throw new Error(`setSetting(${input.key}): no row returned`);
    return row;
  }

  async deleteSetting(key: string): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM settings WHERE key = $1`, [key])) > 0;
  }

  // ─────────────────────────────── sections ───────────────────────────────

  async listSections(page = 'home'): Promise<SectionRow[]> {
    return this.conn.many<SectionRow>(
      `SELECT * FROM sections WHERE page = $1 ORDER BY sort_order, created_at`,
      [page],
    );
  }

  async upsertSection(data: Partial<SectionRow> & { page: string; kind: string }): Promise<SectionRow> {
    if (data.id) {
      const updated = await this.update<SectionRow>('sections', 'id', data.id, {
        ...toColumns(data, ['page', 'kind', 'title', 'titleEn', 'subtitle', 'config', 'sortOrder', 'isVisible']),
        updated_at: new Date(),
      });
      if (updated) return updated;
    }
    const maxSort = (await this.conn.value<number>(`SELECT coalesce(max(sort_order), -1) + 1 FROM sections WHERE page = $1`, [data.page])) ?? 0;
    return this.insert<SectionRow>('sections', {
      id: newId(),
      page: data.page,
      kind: data.kind,
      title: data.title ?? null,
      title_en: data.titleEn ?? null,
      subtitle: data.subtitle ?? null,
      config: JSON.stringify(data.config ?? {}),
      sort_order: data.sortOrder ?? maxSort,
      is_visible: data.isVisible ?? true,
      updated_at: new Date(),
    });
  }

  async reorderSections(page: string, orderedIds: ID[]): Promise<void> {
    await this.conn.tx(async (tx) => {
      for (const [i, id] of orderedIds.entries()) {
        await tx.run(`UPDATE sections SET sort_order = $3, updated_at = now() WHERE id = $1 AND page = $2`, [id, page, i]);
      }
    });
  }

  async deleteSection(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM sections WHERE id = $1`, [id])) > 0;
  }

  // ──────────────────────────────── themes ────────────────────────────────

  async listThemes(): Promise<ThemeRow[]> {
    return this.conn.many<ThemeRow>(`SELECT * FROM themes ORDER BY is_default DESC, name`);
  }

  async activeTheme(): Promise<ThemeRow | null> {
    return (
      (await this.conn.one<ThemeRow>(`SELECT * FROM themes WHERE is_default = true AND is_active = true LIMIT 1`)) ??
      (await this.conn.one<ThemeRow>(`SELECT * FROM themes WHERE is_active = true ORDER BY created_at LIMIT 1`))
    );
  }

  async upsertTheme(data: Partial<ThemeRow> & { slug: string; name: string }): Promise<ThemeRow> {
    const row = await this.conn.one<ThemeRow>(
      `INSERT INTO themes (id, slug, name, is_active, is_default, config, preview_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,now())
       -- is_active is deliberately NOT in the update list: editing a theme's name or
       -- colours must not change which theme the site is serving.
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
         config = EXCLUDED.config, preview_url = EXCLUDED.preview_url, updated_at = now()
       RETURNING *`,
      [
        newId(),
        data.slug,
        data.name,
        // A theme that was just registered is not live. `is_active` is only ever
        // flipped by setDefaultTheme, so "save this theme" can never accidentally
        // switch the whole site over to it.
        data.isActive ?? false,
        data.isDefault ?? false,
        JSON.stringify(data.config ?? {}),
        data.previewUrl ?? null,
      ],
    );
    if (!row) throw new Error('upsertTheme: no row returned');
    if (data.isDefault) await this.setDefaultTheme(data.slug);
    return row;
  }

  /**
   * Switch the site over to one theme.
   *
   * Both flags are cleared first: `is_active` used to be set on the new theme
   * without being cleared on the old ones, so every theme that had ever been
   * activated stayed active and `GET /api/themes` reported four themes as live.
   *
   * Returns false when the slug matches no row, which is what lets the service
   * answer 404 instead of reporting success for a theme that does not exist.
   */
  async setDefaultTheme(slug: string): Promise<boolean> {
    return this.conn.tx(async (tx) => {
      // Existence is checked first rather than inferred from the UPDATE's rowcount:
      // clearing the flags and then discovering the slug was unknown would leave the
      // site with no active theme at all if the transaction ever failed to roll back.
      const exists = await tx.value<number>(`SELECT 1 FROM themes WHERE slug = $1`, [slug]);
      if (exists === null) return false;
      // Both statements in one transaction, so a reader never sees the moment when
      // no theme is active.
      await tx.run(`UPDATE themes SET is_default = false, is_active = false WHERE is_default = true OR is_active = true`);
      await tx.run(`UPDATE themes SET is_default = true, is_active = true, updated_at = now() WHERE slug = $1`, [slug]);
      return true;
    });
  }

  // ─────────────────────────────── redirects ───────────────────────────────

  async findRedirect(sourcePath: string): Promise<RedirectRow | null> {
    return this.conn.one<RedirectRow>(`SELECT * FROM redirects WHERE source_path = $1 AND is_active = true`, [sourcePath]);
  }

  async trackRedirectHit(id: ID): Promise<void> {
    // Fire-and-forget counter: a hit tally must never be the reason a redirect
    // response is slow or fails.
    await this.conn.run(`UPDATE redirects SET hits = hits + 1 WHERE id = $1`, [id]);
  }

  async listRedirects(page?: { page: number; perPage: number; offset: number }): Promise<List<RedirectRow>> {
    const p = pageOf(page, 50);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM redirects`)) ?? 0;
    const items = await this.conn.many<RedirectRow>(`SELECT * FROM redirects ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [
      p.perPage,
      p.offset,
    ]);
    return { items, total };
  }

  async upsertRedirect(data: { sourcePath: string; targetPath: string; statusCode?: number }): Promise<RedirectRow> {
    const row = await this.conn.one<RedirectRow>(
      `INSERT INTO redirects (id, source_path, target_path, status_code, is_active)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (source_path) DO UPDATE SET target_path = EXCLUDED.target_path, status_code = EXCLUDED.status_code, is_active = true
       RETURNING *`,
      [newId(), data.sourcePath, data.targetPath, data.statusCode ?? 301],
    );
    if (!row) throw new Error('upsertRedirect: no row returned');
    return row;
  }

  async deleteRedirect(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM redirects WHERE id = $1`, [id])) > 0;
  }

  // ────────────────────────────── activity log ──────────────────────────────

  async logActivity(input: {
    actorId?: ID | null;
    actorLabel?: string | null;
    action: string;
    targetKind?: string | null;
    targetId?: ID | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.conn.run(
      `INSERT INTO activity_logs (actor_id, actor_label, action, target_kind, target_id, before, after, ip, user_agent, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,now())`,
      [
        input.actorId ?? null,
        input.actorLabel ?? null,
        input.action,
        input.targetKind ?? null,
        input.targetId ?? null,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
  }

  async listActivity(filter: { actorId?: ID; action?: string; page?: { page: number; perPage: number; offset: number } } = {}): Promise<
    List<ActivityLogRow>
  > {
    const conds: SqlPart[] = [];
    if (filter.actorId) conds.push(eq('actor_id', filter.actorId)!);
    if (filter.action) conds.push(eq('action', filter.action)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 50);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM activity_logs WHERE ${where.text}`, where.values)) ?? 0;
    const items = await this.conn.many<ActivityLogRow>(
      `SELECT * FROM activity_logs WHERE ${where.text} ORDER BY created_at DESC LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items, total };
  }

  // ─────────────────────────────── providers ───────────────────────────────

  async listProviders(): Promise<ProviderRow[]> {
    return this.conn.many<ProviderRow>(`SELECT * FROM providers ORDER BY is_active DESC, name`);
  }

  async findProviderBySlug(slug: string): Promise<ProviderRow | null> {
    return this.conn.one<ProviderRow>(`SELECT * FROM providers WHERE slug = $1`, [slug]);
  }

  async upsertProvider(data: Partial<ProviderRow> & { slug: string; name: string }): Promise<ProviderRow> {
    const row = await this.conn.one<ProviderRow>(
      `INSERT INTO providers (id, slug, name, kind, base_url, feed_url, api_key, is_active, sync_interval_minutes, settings, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, base_url = EXCLUDED.base_url,
         feed_url = EXCLUDED.feed_url, is_active = EXCLUDED.is_active,
         sync_interval_minutes = EXCLUDED.sync_interval_minutes, settings = EXCLUDED.settings, updated_at = now()
       RETURNING *`,
      [
        newId(),
        data.slug,
        data.name,
        data.kind ?? 'custom',
        data.baseUrl ?? null,
        data.feedUrl ?? null,
        // An existing key is never overwritten with null: re-saving a provider
        // in the admin UI without re-typing the secret must not delete it.
        data.apiKey ?? (await this.conn.value<string | null>(`SELECT api_key FROM providers WHERE slug = $1`, [data.slug])) ?? null,
        data.isActive ?? true,
        data.syncIntervalMinutes ?? 360,
        JSON.stringify(data.settings ?? {}),
      ],
    );
    if (!row) throw new Error('upsertProvider: no row returned');
    return row;
  }

  async updateProvider(id: ID, patch: Partial<ProviderRow>): Promise<ProviderRow | null> {
    await this.update('providers', 'id', id, {
      ...toColumns(patch, ['name', 'kind', 'baseUrl', 'feedUrl', 'apiKey', 'isActive', 'syncIntervalMinutes', 'lastSyncAt', 'lastStatus']),
      ...(patch.settings ? { settings: JSON.stringify(patch.settings) } : {}),
      updated_at: new Date(),
    });
    return this.conn.one<ProviderRow>(`SELECT * FROM providers WHERE id = $1`, [id]);
  }

  /**
   * Stages a fetched game. The `source_hash` unique index is the duplicate
   * gate: `existed === true` means "we already have this game", and the caller
   * counts it instead of inserting a second copy.
   */
  async stageProviderItem(input: {
    providerId: ID;
    providerGameId: string;
    sourceHash: string;
    title?: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ id: number; existed: boolean }> {
    const existing = await this.conn.one<{ id: number }>(`SELECT id FROM provider_items WHERE source_hash = $1`, [input.sourceHash]);
    if (existing) return { id: existing.id, existed: true };
    const row = await this.conn.one<{ id: number }>(
      `INSERT INTO provider_items (provider_id, provider_game_id, source_hash, title, payload, status, fetched_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'new',now())
       ON CONFLICT (source_hash) DO UPDATE SET payload = EXCLUDED.payload, title = EXCLUDED.title, fetched_at = now()
       RETURNING id`,
      [input.providerId, input.providerGameId, input.sourceHash, input.title ?? null, JSON.stringify(input.payload)],
    );
    if (!row) throw new Error('stageProviderItem: no row returned');
    return { id: row.id, existed: false };
  }

  async markProviderItem(id: number, status: string, extra: { gameId?: ID | null; error?: string | null } = {}): Promise<void> {
    await this.conn.run(
      // $2 is used twice (assignment + comparison). Without the explicit cast
      // Postgres deduces it once as the enum and once as text and refuses the
      // query with "inconsistent types deduced for parameter $2".
      `UPDATE provider_items SET status = $2::provider_item_status, game_id = coalesce($3, game_id), error = $4,
              imported_at = CASE WHEN $2::provider_item_status = 'imported' THEN now() ELSE imported_at END
        WHERE id = $1`,
      [id, status, extra.gameId ?? null, extra.error ?? null],
    );
  }

  async listProviderItems(filter: { providerId?: ID; status?: string; page?: { page: number; perPage: number; offset: number } } = {}): Promise<
    List<ProviderItemRow>
  > {
    const conds: SqlPart[] = [];
    if (filter.providerId) conds.push(eq('provider_id', filter.providerId)!);
    if (filter.status) conds.push(eq('status', filter.status)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 50);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM provider_items WHERE ${where.text}`, where.values)) ?? 0;
    const items = await this.conn.many<ProviderItemRow>(
      `SELECT * FROM provider_items WHERE ${where.text} ORDER BY fetched_at DESC LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items, total };
  }

  async createImportJob(input: { providerId: ID; triggeredBy?: string; actorId?: ID | null }): Promise<ImportJobRow> {
    return this.insert<ImportJobRow>('import_jobs', {
      provider_id: input.providerId,
      status: 'queued',
      triggered_by: input.triggeredBy ?? 'manual',
      actor_id: input.actorId ?? null,
      started_at: new Date(),
    });
  }

  async updateImportJob(id: number, patch: Partial<ImportJobRow>): Promise<void> {
    await this.update('import_jobs', 'id', id, toColumns(patch, [
      'status',
      'cursor',
      'fetchedCount',
      'importedCount',
      'duplicateCount',
      'failedCount',
      'startedAt',
      'finishedAt',
      'error',
    ]));
  }

  async listImportJobs(filter: { providerId?: ID; page?: { page: number; perPage: number; offset: number } } = {}): Promise<List<ImportJobRow>> {
    const conds: SqlPart[] = [];
    if (filter.providerId) conds.push(eq('j.provider_id', filter.providerId)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 25);
    const total =
      (await this.conn.value<number>(
        `SELECT count(*)::int FROM import_jobs j JOIN providers pr ON pr.id = j.provider_id WHERE ${where.text}`,
        where.values,
      )) ?? 0;
    const items = await this.conn.many<ImportJobRow>(
      `SELECT j.*, jsonb_build_object('slug', pr.slug, 'name', pr.name) AS provider
         FROM import_jobs j JOIN providers pr ON pr.id = j.provider_id
        WHERE ${where.text} ORDER BY j.created_at DESC LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return {
      items: items.map((j) => ({
        ...j,
        provider: j.provider as unknown as { slug: string; name: string },
      })),
      total,
    };
  }

  // ─────────────────────── self-update & backups ───────────────────────

  async listReleases(channel = 'stable'): Promise<ReleaseRow[]> {
    return this.conn.many<ReleaseRow>(
      `SELECT * FROM releases WHERE channel = $1 ORDER BY released_at DESC NULLS LAST, created_at DESC`,
      [channel],
    );
  }

  async latestRelease(channel = 'stable'): Promise<ReleaseRow | null> {
    return this.conn.one<ReleaseRow>(
      `SELECT * FROM releases WHERE channel = $1 AND released_at IS NOT NULL AND released_at <= now()
        ORDER BY released_at DESC LIMIT 1`,
      [channel],
    );
  }

  async upsertRelease(data: Partial<ReleaseRow> & { version: string }): Promise<ReleaseRow> {
    const row = await this.conn.one<ReleaseRow>(
      `INSERT INTO releases (id, version, channel, notes, package_url, checksum_sha256, size_bytes, is_mandatory, min_schema_version, released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (version) DO UPDATE SET channel = EXCLUDED.channel, notes = EXCLUDED.notes, package_url = EXCLUDED.package_url,
         checksum_sha256 = EXCLUDED.checksum_sha256, size_bytes = EXCLUDED.size_bytes, is_mandatory = EXCLUDED.is_mandatory,
         released_at = EXCLUDED.released_at
       RETURNING *`,
      [
        newId(),
        data.version,
        data.channel ?? 'stable',
        data.notes ?? null,
        data.packageUrl ?? null,
        data.checksumSha256 ?? null,
        data.sizeBytes ?? null,
        data.isMandatory ?? false,
        data.minSchemaVersion ?? null,
        data.releasedAt ?? new Date(),
      ],
    );
    if (!row) throw new Error('upsertRelease: no row returned');
    return row;
  }

  async createBackup(data: Partial<BackupRow> & { kind: string; trigger?: string }): Promise<BackupRow> {
    return this.insert<BackupRow>('backups', {
      id: newId(),
      kind: data.kind,
      status: data.status ?? 'pending',
      path: data.path ?? null,
      storage_key: data.storageKey ?? null,
      size_bytes: data.sizeBytes ?? null,
      checksum_sha256: data.checksumSha256 ?? null,
      trigger: data.trigger ?? 'manual',
      meta: data.meta ? JSON.stringify(data.meta) : null,
    });
  }

  async updateBackup(id: ID, patch: Partial<BackupRow>): Promise<BackupRow | null> {
    await this.update('backups', 'id', id, {
      ...toColumns(patch, ['status', 'path', 'storageKey', 'sizeBytes', 'checksumSha256', 'error', 'finishedAt']),
      ...(patch.meta ? { meta: JSON.stringify(patch.meta) } : {}),
    });
    return this.conn.one<BackupRow>(`SELECT * FROM backups WHERE id = $1`, [id]);
  }

  async listBackups(page?: { page: number; perPage: number; offset: number }): Promise<List<BackupRow>> {
    const p = pageOf(page, 25);
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM backups`)) ?? 0;
    const items = await this.conn.many<BackupRow>(`SELECT * FROM backups ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [
      p.perPage,
      p.offset,
    ]);
    return { items, total };
  }
}
