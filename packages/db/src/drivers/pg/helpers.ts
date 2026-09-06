/**
 * Shared plumbing for the SQL driver: paging, WHERE composition, and the
 * "fetch the page, then its relations in two more queries" pattern that keeps
 * every list endpoint at a constant three statements instead of N+1.
 */

import { PAGINATION } from '@voltade/shared';
import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type { ID, List, Page } from '../../ports.js';
import { bindValue } from './column-types.js';

export const DEFAULT_PAGE: Page = { page: 1, perPage: PAGINATION.defaultPerPage, offset: 0 };

export function pageOf(p?: Page, fallbackPerPage: number = PAGINATION.defaultPerPage): Page {
  const perPage = Math.min(Math.max(1, Math.trunc(p?.perPage || fallbackPerPage)), 120);
  const page = Math.max(1, Math.trunc(p?.page || 1));
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Opaque row id: 24 characters from a 62-symbol alphabet (~143 bits of entropy).
 * Generated in the application rather than by the database so the SQL and Prisma
 * drivers produce identical ids and a row can be fully built before INSERT.
 */
export function newId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length]!;
  return out;
}

/** A 32-hex sha256 of arbitrary bytes (tokens are stored hashed, never raw). */
export function randomToken(length = 24): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]!).join('');
}

export function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Partial row → physical columns, restricted to an explicit allowlist.
 *
 * The allowlist is the point: without it, `updateGame(id, req.body)` would let a
 * client write `plays`, `rating_avg` or the generated `search_vector` column —
 * mass assignment is how marketplace scripts end up with forged counters.
 */
export function toColumns<T extends Record<string, unknown>>(data: T, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data[f];
    if (v !== undefined) out[snakeCase(f)] = v;
  }
  return out;
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export abstract class PgRepo {
  constructor(protected readonly conn: Connection) {}

  /**
   * SELECT + COUNT over the *same* WHERE, so the pager can never disagree with
   * the rows it is paging. LIMIT/OFFSET are bound as parameters (they are
   * integers by construction, but binding costs nothing and keeps the habit).
   */
  protected async paged<T>(opts: {
    select: string;
    from: string;
    where?: SqlPart | null;
    orderBy?: string;
    page?: Page;
  }): Promise<List<T>> {
    const page = pageOf(opts.page);
    const where = opts.where ? resolvePart(opts.where) : { text: '', values: [] };
    const whereSql = where.text ? `WHERE ${where.text}` : '';

    const countSql = `SELECT count(*)::int AS total FROM ${opts.from} ${whereSql}`;
    const listSql = `${opts.select} FROM ${opts.from} ${whereSql} ${opts.orderBy ?? ''} LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`;

    const [total, items] = await Promise.all([
      this.conn.value<number>(countSql, where.values),
      this.conn.many<T>(listSql, [...where.values, page.perPage, page.offset]),
    ]);
    return { items, total: total ?? 0 };
  }

  /** INSERT … RETURNING * built from a partial object, so a repository method
   *  never has to enumerate columns twice (once in SQL, once in TS). Values pass
   *  through bindValue(), which JSON-encodes jsonb columns: the caller hands over
   *  plain objects and arrays and the driver knows which column is which. */
  protected async insert<T>(table: string, data: Record<string, unknown>): Promise<T> {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    if (entries.length === 0) throw new Error(`insert into ${table}: no columns`);
    const cols = entries.map(([k]) => k).join(', ');
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
    const row = await this.conn.one<T>(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`,
      entries.map(([k, v]) => bindValue(table, k, v)),
    );
    if (!row) throw new Error(`insert into ${table} returned no row`);
    return row;
  }

  /** UPDATE … SET (only the provided keys) … RETURNING *. */
  protected async update<T>(table: string, idColumn: string, id: unknown, patch: Record<string, unknown>): Promise<T | null> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return this.conn.one<T>(`SELECT * FROM "${table}" WHERE "${idColumn}" = $1`, [id]);
    const sets = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(', ');
    return this.conn.one<T>(
      `UPDATE "${table}" SET ${sets} WHERE "${idColumn}" = $${entries.length + 1} RETURNING *`,
      [...entries.map(([k, v]) => bindValue(table, k, v)), id],
    );
  }
}

/** Column filters that disappear when the input is absent. */
export function eq(column: string, value: unknown): SqlPart | null {
  if (value === undefined || value === null) return null;
  return sql`${sql.raw(column)} = ${value}`;
}

export function inList(column: string, values: unknown[] | undefined | null): SqlPart | null {
  if (!values || values.length === 0) return null;
  return sql`${sql.raw(column)} = ANY(${values})`;
}

export function boolEq(column: string, value: boolean | undefined): SqlPart | null {
  if (value === undefined) return null;
  return sql`${sql.raw(column)} = ${value}`;
}

export function likeAny(columns: string[], needle: string | undefined | null): SqlPart | null {
  if (!needle || !needle.trim()) return null;
  const pattern = `%${escapeLike(needle.trim())}%`;
  return sql.or(...columns.map((c) => sql`${sql.raw(c)} ILIKE ${pattern}`));
}

/**
 * Loads m-n relations for a page of ids in ONE query and groups them in memory.
 * The query must expose `owner_id`; that is the join back to the parent row.
 */
export async function groupRelations<T>(
  conn: Connection,
  opts: { ids: ID[]; query: string },
): Promise<Map<ID, T[]>> {
  const out = new Map<ID, T[]>();
  if (opts.ids.length === 0) return out;
  const rows = await conn.many<T & { ownerId: ID }>(opts.query, [opts.ids]);
  for (const row of rows) {
    const list = out.get(row.ownerId) ?? [];
    list.push(row);
    out.set(row.ownerId, list);
  }
  return out;
}

export const GAME_CATEGORIES_SQL = `
  SELECT cg.game_id AS owner_id, c.id, c.slug, c.name, c.name_en, cg.position
    FROM category_game cg JOIN categories c ON c.id = cg.category_id
   WHERE cg.game_id = ANY($1) AND c.deleted_at IS NULL
   ORDER BY c.sort_order, c.name`;

export const GAME_TAGS_SQL = `
  SELECT tg.game_id AS owner_id, t.id, t.slug, t.name
    FROM tag_game tg JOIN tags t ON t.id = tg.tag_id
   WHERE tg.game_id = ANY($1)
   ORDER BY t.name`;

export const POST_TAGS_SQL = `
  SELECT bt.post_id AS owner_id, t.id, t.slug, t.name
    FROM blog_post_tag bt JOIN tags t ON t.id = bt.tag_id
   WHERE bt.post_id = ANY($1)
   ORDER BY t.name`;
