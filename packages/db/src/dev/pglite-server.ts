/**
 * Zero-install PostgreSQL for development and CI: PGlite (real PostgreSQL
 * compiled to WASM) speaking the wire protocol on a TCP port.
 *
 * WHY: Voltade must boot with nothing but Node. A developer who has to install
 * Docker, Postgres and Redis before seeing the homepage is a developer who
 * closes the tab. This server gives the *same* connection string shape as the
 * docker-compose Postgres 16 (`postgres://…@127.0.0.1:5433/postgres`), so the
 * API, the migrator and the tests do not know or care which one they got.
 *
 * LIMITS, stated plainly: PGlite serialises queries through one WASM instance,
 * has no `contrib` (so no pg_trgm — fuzzy search falls back to prefix/ILIKE) and
 * is not for production. Production is `docker compose up -d db` or a managed
 * PostgreSQL 16; nothing else in the codebase changes.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PgliteServerOptions = {
  /** directory that holds the database files; `memory://` for an ephemeral db */
  dataDir?: string;
  port?: number;
  host?: string;
  maxConnections?: number;
  quiet?: boolean;
};

export type PgliteServer = {
  url: string;
  port: number;
  stop(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

export async function startPgliteServer(options: PgliteServerOptions = {}): Promise<PgliteServer> {
  const port = options.port ?? Number(process.env.PGLITE_PORT ?? 5433);
  const host = options.host ?? process.env.PGLITE_HOST ?? '127.0.0.1';
  const dataDir = options.dataDir ?? process.env.PGLITE_DATA ?? resolve(process.cwd(), '.var/pglite');
  const quiet = options.quiet ?? false;

  let pgliteModule: typeof import('@electric-sql/pglite');
  let socketModule: typeof import('@electric-sql/pglite-socket');
  try {
    pgliteModule = await import('@electric-sql/pglite');
    socketModule = await import('@electric-sql/pglite-socket');
  } catch {
    throw new Error(
      'PGlite is not installed. Run `npm install` at the repository root, or point DATABASE_URL at a real PostgreSQL and skip `npm run db:up`.',
    );
  }

  if (dataDir !== 'memory://') await mkdir(dataDir, { recursive: true });

  const db = new pgliteModule.PGlite(dataDir);
  await db.waitReady;
  const server = new socketModule.PGLiteSocketServer({
    db,
    port,
    host,
    maxConnections: options.maxConnections ?? 8,
  });
  await server.start();

  const url = `postgres://postgres:postgres@${host}:${port}/postgres`;
  if (!quiet) {
    process.stdout.write(
      [
        '',
        `  PostgreSQL (WASM) listening on ${host}:${port}`,
        `  data dir: ${dataDir}`,
        '',
        `  DATABASE_URL=${url}`,
        '',
      ].join('\n'),
    );
  }

  return {
    url,
    port,
    async stop() {
      await server.stop();
      await db.close();
    },
    async query<T>(sqlText: string, params: unknown[] = []) {
      const res = await db.query<T>(sqlText, params);
      return res.rows;
    },
  };
}
