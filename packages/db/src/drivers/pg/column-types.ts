/**
 * Column types the generic writer cannot infer from a JavaScript value.
 *
 * GENERATED from prisma/schema.prisma — regenerate with `npm run columns:generate`
 * in @voltade/db, never edit by hand (`columns:generate --check` fails CI on drift).
 * 14 jsonb · 3 array · 38 enum columns.
 *
 * WHY THIS EXISTS: node-postgres serialises a JS array as a Postgres array
 * literal (`{a,b}`) and a JS object as `[object Object]`. For a `text[]` column
 * the first is exactly right; for `jsonb` both are wrong, and the failure
 * surfaces as `invalid input syntax for type json` on write. Every repository
 * writes through helpers.insert()/update(), so the mapping lives here once and
 * applies to all of them.
 */

/** jsonb columns per table — values are JSON.stringify'd before binding. */
export const JSONB_COLUMNS: Record<string, readonly string[]> = {
  "achievements": ["rule"],
  "activity_logs": ["after","before"],
  "ads": ["targeting"],
  "backups": ["meta"],
  "games": ["meta"],
  "notifications": ["data"],
  "pages": ["blocks"],
  "payments": ["meta"],
  "provider_items": ["payload"],
  "providers": ["settings"],
  "sections": ["config"],
  "settings": ["value"],
  "themes": ["config"],
};

/** Scalar array columns per table — bound as JS arrays (pg renders `{a,b}`). */
export const ARRAY_COLUMNS: Record<string, readonly string[]> = {
  "games": ["gallery"],
  "plans": ["features"],
  "users": ["two_factor_backup_codes"],
};

/** Enum columns per table → Postgres type name, for explicit `::type` casts. */
export const ENUM_COLUMNS: Record<string, Record<string, string>> = {
  "achievements": {"tier":"badge_tier"},
  "ads": {"placement":"ad_placement","type":"ad_type","status":"ad_status"},
  "backups": {"kind":"backup_kind","status":"backup_status"},
  "blog_posts": {"status":"content_status"},
  "comments": {"status":"comment_status"},
  "daily_stats": {"dimension":"stat_dimension"},
  "game_assets": {"kind":"asset_kind"},
  "game_plays": {"device":"device_kind"},
  "games": {"kind":"game_kind","orientation":"game_orientation","status":"game_status","age_rating":"age_rating"},
  "import_jobs": {"status":"import_status"},
  "likes": {"target_kind":"target_kind"},
  "notifications": {"kind":"notification_kind"},
  "oauth_accounts": {"provider":"oauth_provider"},
  "pages": {"status":"content_status"},
  "payments": {"provider":"payment_provider","status":"payment_status"},
  "plans": {"interval":"plan_interval"},
  "playlists": {"visibility":"playlist_visibility"},
  "provider_items": {"status":"provider_item_status"},
  "providers": {"kind":"provider_kind","last_status":"import_status"},
  "reports": {"target_kind":"target_kind","reason":"report_reason","status":"report_status"},
  "sections": {"kind":"section_kind"},
  "sessions": {"kind":"session_kind"},
  "settings": {"type":"setting_type"},
  "subscriptions": {"status":"subscription_status","provider":"payment_provider"},
  "tags": {"scope":"tag_scope"},
  "users": {"status":"user_status"},
  "xp_events": {"target_kind":"target_kind"},
};

export function isJsonbColumn(table: string, column: string): boolean {
  return (JSONB_COLUMNS[table] ?? []).includes(column);
}

export function enumTypeOf(table: string, column: string): string | undefined {
  return ENUM_COLUMNS[table]?.[column];
}

/** Serialises one value for binding, knowing which column it is going into. */
export function bindValue(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (!isJsonbColumn(table, column)) return value;
  if (typeof value === 'string') {
    // Already JSON (a caller that stringified). Validate instead of
    // double-encoding: JSON.stringify('{}') is '"{}"' — valid JSON, wrong data,
    // and invisible until something reads the row back.
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}
