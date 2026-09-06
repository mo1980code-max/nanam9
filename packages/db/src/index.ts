/**
 * @voltade/db — the data layer.
 *
 * Public surface:
 *   · `connectDatabase()`  → a `Database` port bound to PostgreSQL (node-postgres)
 *   · the Prisma schema in `prisma/schema.prisma` and its SQL migrations
 *   · the migrator (`migrate`), the introspector and the DDL generator that keep
 *     schema.prisma, the committed SQL and the live database in agreement
 *
 * Nothing here imports Nest, Next or React: the same package is used by the API,
 * by the CLI tools and by the tests.
 */

export * from './ports.js';
export * from './sql.js';
export * from './connection.js';
export { createPgDatabase } from './drivers/pg/index.js';
export { newId, pageOf, toColumns, snakeCase } from './drivers/pg/helpers.js';
export { migrate, resetSchema, listMigrations, appliedMigrations, introspect, splitStatements, sha256 } from './migrate/runner.js';
export { generateMigrationSql } from './tools/ddl.js';
export { parsePrismaSchema } from './tools/prisma-schema.js';
export { loadEnv, findRepoRoot, databaseUrl, migrationsDir, schemaPath, DEFAULT_DEV_URL } from './env.js';

import { createConnection, type Connection, type ConnectionOptions } from './connection.js';
import { createPgDatabase } from './drivers/pg/index.js';
import type { Database } from './ports.js';

export type ConnectOptions = Omit<ConnectionOptions, 'connectionString'> & {
  connectionString: string;
  /** Run pending migrations before handing back the database. Default false —
   *  the API must not migrate on boot in production; `npm run db:migrate` does. */
  migrateOnConnect?: boolean;
};

export async function connectDatabase(options: ConnectOptions): Promise<{ db: Database; conn: Connection }> {
  const conn = createConnection(options);
  if (options.migrateOnConnect) {
    const { migrate } = await import('./migrate/runner.js');
    const { migrationsDir } = await import('./env.js');
    await migrate(conn, migrationsDir());
  }
  return { db: createPgDatabase(conn), conn };
}

/** Convenience for scripts and tests that just want a `Database`. */
export async function open(connectionString: string): Promise<Database> {
  const { db } = await connectDatabase({ connectionString });
  return db;
}
