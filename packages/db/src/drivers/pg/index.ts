/**
 * The SQL driver, assembled.
 *
 * `createPgDatabase(conn)` binds every repository to one connection. Passing a
 * *transaction* connection instead gives you the same `Database` shape scoped to
 * that transaction, which is why services can write
 * `db.tx(async (tx) => tx.social.createComment(...))` without any repository
 * knowing that transactions exist.
 */

import type { Connection } from '../../connection.js';
import type { Database, HealthReport } from '../../ports.js';
import { PgCatalogRepository } from './catalog.js';
import { PgCommerceRepository } from './commerce.js';
import { PgContentRepository } from './content.js';
import { PgEngagementRepository } from './engagement.js';
import { PgIdentityRepository } from './identity.js';
import { PgOperationsRepository } from './operations.js';
import { PgSocialRepository } from './social.js';

export function createPgDatabase(conn: Connection): Database {
  const db: Database = {
    driver: 'pg',
    catalog: new PgCatalogRepository(conn),
    social: new PgSocialRepository(conn),
    identity: new PgIdentityRepository(conn),
    engagement: new PgEngagementRepository(conn),
    content: new PgContentRepository(conn),
    commerce: new PgCommerceRepository(conn),
    operations: new PgOperationsRepository(conn),
    async tx<T>(fn: (inner: Database) => Promise<T>): Promise<T> {
      return conn.tx((txConn) => fn(createPgDatabase(txConn)));
    },
    async health(): Promise<HealthReport> {
      const started = performance.now();
      try {
        const version = await conn.value<string>(`SELECT version()`);
        const latencyMs = Math.round(performance.now() - started);
        const [tables, applied] = await Promise.all([
          conn.value<number>(`SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public'`),
          // The bookkeeping table may not exist yet on a brand-new database;
          // health() must report that as "0 migrations", not as a crash.
          conn.value<number>(`SELECT count(*)::int FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`).catch(() => 0),
        ]);
        return {
          ok: true,
          database: { ok: true, version: String(version ?? '').split(',')[0], latencyMs },
          tables: tables ?? 0,
          migrations: { applied: applied ?? 0, pending: 0 },
        };
      } catch (err) {
        return {
          ok: false,
          database: { ok: false, error: err instanceof Error ? err.message : String(err) },
          tables: 0,
          migrations: { applied: 0, pending: 0 },
        };
      }
    },
    async close(): Promise<void> {
      await conn.close();
    },
  };
  return db;
}

export * from './catalog.js';
export * from './commerce.js';
export * from './content.js';
export * from './engagement.js';
export * from './identity.js';
export * from './operations.js';
export * from './social.js';
