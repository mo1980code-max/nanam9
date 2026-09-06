/**
 * The database module: one connection pool for the whole API process.
 *
 * WHY GLOBAL: every feature module needs the `Database` port, and a pool per
 * module means ten pools competing for the same PostgreSQL `max_connections` —
 * a classic way to take a database down at 100 RPS. `@Global()` plus one provider
 * gives every module the same instance with no re-imports.
 *
 * WHY A PORT AND NOT PrismaClient: `@voltade/db` exposes typed repositories over
 * node-postgres. prisma/schema.prisma stays the single source of truth for the
 * DDL (the migrations are generated from it and proved against a live database by
 * the parity tests), while the runtime does not need Prisma's engine binaries —
 * which cannot be downloaded in every build environment.
 *
 * Two tokens are provided because they serve different callers:
 *  · DATABASE     → the repositories. Feature services inject this.
 *  · DB_CONNECTION→ the raw pool, for health checks and the occasional query no
 *                   repository models (the search fallback, admin introspection).
 */

import { Global, Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { connectDatabase, type Connection, type Database } from '@voltade/db';
import { CONFIG, type AppConfig } from '../../config/env.js';

export const DATABASE = Symbol('VOLTADE_DATABASE');
export const DB_CONNECTION = Symbol('VOLTADE_DB_CONNECTION');

export type DatabaseHandle = { db: Database; conn: Connection; close(): Promise<void> };

async function open(config: AppConfig): Promise<DatabaseHandle> {
  const { db, conn } = await connectDatabase({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    applicationName: 'voltade-api',
    // Opt-in on purpose: a container that migrates on boot races its own
    // replicas. `npm run db:migrate` runs as a separate step in the deploy.
    migrateOnConnect: config.DATABASE_MIGRATE_ON_BOOT,
    log: !config.isProduction && process.env.SQL_LOG === '1',
  });
  return { db, conn, close: () => conn.close() };
}

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  private static handle: DatabaseHandle | null = null;

  static forRoot(): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          inject: [CONFIG],
          provide: 'VOLTADE_DB_HANDLE',
          useFactory: async (config: AppConfig): Promise<DatabaseHandle> => {
            DatabaseModule.handle ??= await open(config);
            return DatabaseModule.handle;
          },
        },
        { inject: ['VOLTADE_DB_HANDLE'], provide: DATABASE, useFactory: (h: DatabaseHandle): Database => h.db },
        { inject: ['VOLTADE_DB_HANDLE'], provide: DB_CONNECTION, useFactory: (h: DatabaseHandle): Connection => h.conn },
      ],
      exports: [DATABASE, DB_CONNECTION],
    };
  }

  /** SIGTERM must not leak connections: drain the pool before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await DatabaseModule.handle?.close().catch(() => {});
    DatabaseModule.handle = null;
  }
}

/** Convenience for services that want both tokens in one injection. */
export function InjectDatabase(): ParameterDecorator & PropertyDecorator {
  return Inject(DATABASE) as ParameterDecorator & PropertyDecorator;
}
