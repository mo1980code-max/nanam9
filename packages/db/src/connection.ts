/**
 * The Postgres connection: one `pg.Pool`, snake_case rows camelised on the way
 * out, BIGINTs converted to numbers when they are safe to convert.
 *
 * WHY CAMELISE HERE: the physical schema is snake_case (what a DBA reads) and
 * the application speaks camelCase (what Prisma would have returned). Doing the
 * conversion in one place keeps every repository free of hand-written row
 * mappers — ~40 tables × ~15 columns of boilerplate that would otherwise be the
 * most bug-prone code in the project.
 */

import pg from 'pg';
import { toQuery, type SqlInput } from './sql.js';

const { Pool, types } = pg;

/** pg's OID for int8. Counters (impressions, plays, size_bytes) come back as
 *  strings by default; every one of them fits comfortably in a JS number, and
 *  the frontend would otherwise render "1234" as a string in arithmetic. */
const INT8_OID = 20;
const NUMERIC_OID = 1700;

types.setTypeParser(INT8_OID, (v: string) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
types.setTypeParser(NUMERIC_OID, (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
});

export function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelizeRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camelCase(k)] = v;
  return out as T;
}

export function camelizeRows<T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camelizeRow<T>(r));
}

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Connection {
  many<T = Record<string, unknown>>(query: SqlInput, values?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(query: SqlInput, values?: unknown[]): Promise<T | null>;
  /** First column of the first row — for `select count(*)`. */
  value<T = unknown>(query: SqlInput, values?: unknown[]): Promise<T | null>;
  run(query: SqlInput, values?: unknown[]): Promise<number>;
  tx<T>(fn: (tx: Connection) => Promise<T>): Promise<T>;
  /** Escape hatch for the migrator, which must run raw DDL strings. */
  unsafe(text: string): Promise<void>;
  close(): Promise<void>;
}

export type ConnectionOptions = {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
  /** Print every statement — set SQL_LOG=1 while developing. */
  log?: boolean;
};

export function createConnection(options: ConnectionOptions): Connection {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    // `application_name` shows up in pg_stat_activity, so "which process holds
    // this connection" is answerable from the database side while debugging.
    options: `-c application_name=${(options.applicationName ?? 'voltade').replace(/[^a-z0-9_-]/gi, '_')}`,
    // Voltade runs behind Cloudflare with TLS to the origin; the database URL
    // decides TLS, so nothing here overrides it.
  });

  const log = options.log ?? process.env.SQL_LOG === '1';

  /**
   * Clients that are already inside a transaction.
   *
   * `tx()` has to be re-entrant: a transactional repository method is called from a
   * service-level transaction all the time, and a nested BEGIN is a warning at best.
   * Tracking it explicitly also means a caller that hands us a dedicated client
   * instead of a pool still gets a real BEGIN/COMMIT/ROLLBACK — the alternative is a
   * `tx()` that quietly commits statement by statement, which is the worst kind of
   * bug to find in production.
   */
  const inTransaction = new WeakSet<object>();

  const makeConnection = (client: pg.PoolClient | pg.Pool): Connection => {
    const exec = async <T>(query: SqlInput, values: unknown[] = []): Promise<QueryResult<T>> => {
      const { text, values: params } = toQuery(query, values);
      const started = log ? performance.now() : 0;
      const res = await client.query(text, params);
      if (log) {
        const ms = (performance.now() - started).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(`[sql ${ms}ms] ${text.replace(/\s+/g, ' ').slice(0, 400)}`, params.length ? params : '');
      }
      return { rows: camelizeRows<T>(res.rows as Record<string, unknown>[]), rowCount: res.rowCount ?? 0 };
    };

    return {
      many: async <T>(q: SqlInput, v: unknown[] = []) => (await exec<T>(q, v)).rows,
      one: async <T>(q: SqlInput, v: unknown[] = []) => (await exec<T>(q, v)).rows[0] ?? null,
      value: async <T>(q: SqlInput, v: unknown[] = []) => {
        const rows = await exec<Record<string, unknown>>(q, v);
        const first = rows.rows[0];
        if (!first) return null;
        return Object.values(first)[0] as T;
      },
      run: async (q: SqlInput, v: unknown[] = []) => (await exec(q, v)).rowCount,
      tx: async <T>(fn: (tx: Connection) => Promise<T>): Promise<T> => {
        if (client instanceof pg.Pool) {
          // A pool-level transaction needs a dedicated client; nested tx() calls
          // reuse the same client so a repository method can call another one.
          const pc = await pool.connect();
          inTransaction.add(pc);
          try {
            await pc.query('BEGIN');
            const result = await fn(makeConnection(pc as unknown as pg.Pool));
            await pc.query('COMMIT');
            return result;
          } catch (err) {
            await pc.query('ROLLBACK');
            throw err;
          } finally {
            inTransaction.delete(pc);
            pc.release();
          }
        }
        // A dedicated client that is already inside a transaction: join it, so a
        // nested tx() cannot start a second one.
        if (inTransaction.has(client)) return fn(client as unknown as Connection);
        inTransaction.add(client);
        try {
          await client.query('BEGIN');
          const result = await fn(client as unknown as Connection);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          inTransaction.delete(client);
        }
      },
      unsafe: async (text: string) => {
        await client.query(text);
      },
      close: async () => {
        if (client instanceof pg.Pool) await pool.end();
      },
    };
  };

  return makeConnection(pool);
}

export async function ping(connectionString: string, timeoutMs = 5000): Promise<{ ok: boolean; version?: string; error?: string }> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    const res = await client.query('select version() as v');
    return { ok: true, version: (res.rows[0] as { v: string }).v };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
