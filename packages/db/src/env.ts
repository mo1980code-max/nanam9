/**
 * Environment loading for every Voltade CLI.
 *
 * One rule: `.env` at the repository root wins over nothing, and the real
 * environment wins over `.env`. A CLI that silently used a different database
 * than the API would be worse than no CLI at all.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSyncSafe(pkg)) as { workspaces?: unknown; name?: string };
        if (parsed.workspaces || parsed.name === 'voltade-monorepo') return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

function readFileSyncSafe(path: string): string {
  return readFileSync(path, 'utf8');
}

export function loadEnv(root = findRepoRoot()): { root: string; loaded: boolean } {
  const file = join(root, '.env');
  if (!existsSync(file)) return { root, loaded: false };
  loadDotenv({ path: file, override: false });
  return { root, loaded: true };
}

/** The URL the local PGlite dev server listens on (see src/dev/pglite-server.ts). */
export const DEFAULT_DEV_URL = 'postgres://postgres:postgres@127.0.0.1:5433/postgres';

export function databaseUrl(override?: string): string {
  const url = override ?? process.env.DATABASE_URL ?? process.env.PG_URL;
  if (!url) {
    throw new Error(
      [
        'DATABASE_URL is not set.',
        '',
        '  · local development:  npm run db:up      (starts PostgreSQL-in-WASM on :5433)',
        '  · docker:             docker compose up -d db  → postgres://voltade:voltade@localhost:5432/voltade',
        '',
        `  or pass it explicitly: ${DEFAULT_DEV_URL}`,
      ].join('\n'),
    );
  }
  return url;
}

/** Root of the @voltade/db package, whether this file runs from src/ or dist/. */
export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function migrationsDir(root = packageRoot()): string {
  return resolve(root, 'prisma/migrations');
}

export function schemaPath(root = packageRoot()): string {
  return resolve(root, 'prisma/schema.prisma');
}
