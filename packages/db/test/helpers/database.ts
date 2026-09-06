/**
 * Test harness: a real PostgreSQL, in-process, per test file.
 *
 * PGlite is PostgreSQL compiled to WASM, so these tests run the *same* SQL,
 * constraints, enums, generated tsvector columns and GIN indexes that production
 * runs — through the same node-postgres driver the API uses. Nothing is mocked,
 * which is the only way a data-layer test can catch a real bug (a wrong enum
 * cast, a mis-numbered placeholder, a missing unique index).
 *
 * `memory://` means every file starts from nothing: migrate → seed → assert.
 */

import { createServer } from 'node:net';
import { connectDatabase, type ConnectOptions } from '../../src/index.js';
import type { Connection } from '../../src/connection.js';
import type { Database } from '../../src/ports.js';
import { migrate, introspect } from '../../src/migrate/runner.js';
import { migrationsDir } from '../../src/env.js';
import { startPgliteServer, type PgliteServer } from '../../src/dev/pglite-server.js';

export type TestDatabase = {
  db: Database;
  conn: Connection;
  url: string;
  close(): Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Boots PGlite, applies every committed migration, hands back a Database. */
export async function withDatabase(options: Partial<ConnectOptions> = {}): Promise<TestDatabase> {
  const port = await freePort();
  let server: PgliteServer;
  try {
    server = await startPgliteServer({ dataDir: 'memory://', port, quiet: true });
  } catch (error) {
    throw new Error(
      `PGlite could not start — the database tests need @electric-sql/pglite installed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // A small pool on purpose: PGlite answers through ONE WASM instance, so a
  // 10-connection pool buys nothing and a burst of parallel queries (the
  // dashboard issues 11 at once) can have a connection reset underneath it.
  // Production runs a real PostgreSQL with the default pool of 10.
  const { db, conn } = await connectDatabase({
    connectionString: server.url,
    applicationName: 'voltade-test',
    max: 3,
    ...options,
  });
  const result = await migrate(conn, migrationsDir());
  if (result.checksumMismatches.length > 0) {
    throw new Error(`migration checksum mismatch: ${result.checksumMismatches.map((m) => m.name).join(', ')}`);
  }

  return {
    db,
    conn,
    url: server.url,
    async close() {
      await db.close().catch(() => {});
      await conn.close().catch(() => {});
      await server.stop().catch(() => {});
    },
  };
}

export { introspect, migrationsDir };
