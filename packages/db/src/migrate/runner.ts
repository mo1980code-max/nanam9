/**
 * Migration runner.
 *
 * It reads the same `prisma/migrations/<timestamp>_<name>/migration.sql` layout
 * Prisma uses and writes to the same `_prisma_migrations` bookkeeping table with
 * the same columns, so `prisma migrate deploy` on a machine that has the engines
 * and this runner on a machine that does not are interchangeable: neither will
 * re-apply the other's work. That matters because Voltade has to install on a
 * plain VPS with nothing but Node and a database URL.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection } from '../connection.js';

export type Migration = {
  /** directory name, e.g. 20260905120000_init */
  name: string;
  sql: string;
  checksum: string;
  path: string;
};

export type AppliedMigration = {
  name: string;
  checksum: string;
  finishedAt: string | null;
  logs: string | null;
};

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                  VARCHAR(36)  NOT NULL PRIMARY KEY,
    "checksum"            VARCHAR(64)  NOT NULL,
    "finished_at"         TIMESTAMPTZ,
    "migration_name"      VARCHAR(255) NOT NULL,
    "logs"                TEXT,
    "rolled_back_at"      TIMESTAMPTZ,
    "started_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER      NOT NULL DEFAULT 0
);
`;

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Splits a migration file into statements.
 *
 * Semicolons inside string literals, dollar-quoted bodies (`$$ … $$` in a
 * function) and comments are not terminators. Getting this wrong turns one
 * migration into a syntax error at install time on a customer's server, which is
 * precisely the failure mode this project exists to avoid.
 */
export function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = 0;
  let dollarTag: string | null = null;

  while (i < sqlText.length) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];

    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment > 0) {
      if (ch === '/' && next === '*') {
        inBlockComment++;
        cur += '/*';
        i += 2;
        continue;
      }
      if (ch === '*' && next === '/') {
        inBlockComment--;
        cur += '*/';
        i += 2;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (dollarTag) {
      if (sqlText.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        cur += "''";
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      cur += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        cur += '""';
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      cur += ch;
      i++;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      cur += '--';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = 1;
      cur += '/*';
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(sqlText.slice(i));
      if (m) {
        dollarTag = m[0];
        cur += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      const stmt = cur.trim();
      if (stmt) out.push(stmt);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }

  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

export async function listMigrations(dir: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const migrations: Migration[] = [];
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (!info.isDirectory()) continue;
    const file = join(full, 'migration.sql');
    try {
      const sql = await readFile(file, 'utf8');
      migrations.push({ name: entry, sql, checksum: sha256(sql), path: file });
    } catch {
      // A directory without migration.sql is not a migration (could be a note).
      continue;
    }
  }
  return migrations;
}

export async function appliedMigrations(conn: Connection): Promise<Map<string, AppliedMigration>> {
  const rows = await conn.many<{ name: string; checksum: string; finishedAt: string | null; logs: string | null }>(
    `SELECT migration_name AS name, checksum, finished_at AS "finishedAt", logs
       FROM "_prisma_migrations"
      WHERE rolled_back_at IS NULL`,
  );
  return new Map(rows.map((r) => [r.name, r]));
}

export async function ensureMigrationsTable(conn: Connection): Promise<void> {
  await conn.unsafe(MIGRATIONS_TABLE);
}

export type ApplyOptions = {
  onStatement?: (migration: string, index: number, total: number, text: string) => void;
  onApplied?: (migration: string, statements: number) => void;
};

export type ApplyResult = {
  applied: string[];
  skipped: string[];
  checksumMismatches: { name: string; recorded: string; actual: string }[];
};

export async function migrate(
  conn: Connection,
  dir: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  await ensureMigrationsTable(conn);
  const migrations = await listMigrations(dir);
  const applied = await appliedMigrations(conn);
  const result: ApplyResult = { applied: [], skipped: [], checksumMismatches: [] };

  for (const m of migrations) {
    const record = applied.get(m.name);
    if (record) {
      if (record.checksum !== m.checksum) {
        // A changed checksum means someone edited an applied migration. Refusing
        // is the only safe answer: applying it again would double-run DDL, and
        // staying silent hides that the database no longer matches the repo.
        result.checksumMismatches.push({ name: m.name, recorded: record.checksum, actual: m.checksum });
      }
      result.skipped.push(m.name);
      continue;
    }

    const statements = splitStatements(m.sql);
    await conn.tx(async (tx) => {
      for (let i = 0; i < statements.length; i++) {
        options.onStatement?.(m.name, i + 1, statements.length, statements[i]!);
        await tx.unsafe(statements[i]!);
      }
      await tx.run(
        `INSERT INTO "_prisma_migrations"
           (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count)
         VALUES ($1, $2, now(), $3, NULL, now(), $4)`,
        [randomId(), m.checksum, m.name, 1],
      );
    });
    options.onApplied?.(m.name, statements.length);
    result.applied.push(m.name);
  }

  return result;
}

/** Drops everything in `public` and starts over. Dev/CI only — the CLI requires
 *  an explicit `--reset` and refuses when NODE_ENV=production. */
export async function resetSchema(conn: Connection): Promise<void> {
  await conn.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.unsafe('CREATE SCHEMA public');
  await conn.unsafe('GRANT ALL ON SCHEMA public TO PUBLIC');
}

export function randomId(): string {
  return createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 32);
}

/**
 * The database's own view of itself: tables, columns, indexes. Used by the
 * parity test to prove schema.prisma, the SQL and the live database agree.
 */
export async function introspect(conn: Connection): Promise<{
  tables: Record<string, { columns: Record<string, { type: string; nullable: boolean; default: string | null }> }>;
  indexes: Record<string, string[]>;
  enums: Record<string, string[]>;
}> {
  const cols = await conn.many<{
    tableName: string;
    columnName: string;
    dataType: string;
    udtName: string;
    isNullable: string;
    columnDefault: string | null;
  }>(
    `SELECT table_name AS "tableName", column_name AS "columnName", data_type AS "dataType",
            udt_name AS "udtName", is_nullable AS "isNullable", column_default AS "columnDefault"
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );

  const tables: Record<string, { columns: Record<string, { type: string; nullable: boolean; default: string | null }> }> = {};
  for (const c of cols) {
    tables[c.tableName] ??= { columns: {} };
    // data_type says "USER-DEFINED" for enums; udt_name carries the real name.
    const type = c.dataType === 'USER-DEFINED' ? c.udtName : c.dataType;
    tables[c.tableName]!.columns[c.columnName] = {
      type,
      nullable: c.isNullable === 'YES',
      default: c.columnDefault,
    };
  }

  const idx = await conn.many<{ tableName: string; indexName: string; definition: string }>(
    `SELECT tablename AS "tableName", indexname AS "indexName", indexdef AS definition
       FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const indexes: Record<string, string[]> = {};
  for (const i of idx) {
    indexes[i.tableName] ??= [];
    indexes[i.tableName]!.push(i.indexName);
  }

  const enums = await conn.many<{ typeName: string; label: string }>(
    `SELECT t.typname AS "typeName", e.enumlabel AS label
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder`,
  );
  const enumMap: Record<string, string[]> = {};
  for (const e of enums) {
    enumMap[e.typeName] ??= [];
    enumMap[e.typeName]!.push(e.label);
  }

  return { tables, indexes, enums: enumMap };
}
