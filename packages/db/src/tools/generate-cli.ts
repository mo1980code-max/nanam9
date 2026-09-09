/**
 * `npm run sql:generate` — schema.prisma → prisma/migrations/<ts>_init/migration.sql
 * `npm run sql:generate -- --check` — fail if the committed SQL is stale.
 *
 * --check is the CI gate: it makes "someone edited the schema and forgot the
 * migration" a red build instead of a production incident.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateMigrationSql } from './ddl.js';
import { parsePrismaSchema } from './prisma-schema.js';

export type GenerateArgs = {
  check: boolean;
  schema: string;
  out?: string;
  migrationsDir: string;
  name?: string;
};

export function parseArgs(argv: string[], defaults: { schema: string; migrationsDir: string }): GenerateArgs {
  const args: GenerateArgs = { check: false, schema: defaults.schema, migrationsDir: defaults.migrationsDir };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '-c') args.check = true;
    else if (a === '--schema') args.schema = argv[++i]!;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--dir') args.migrationsDir = argv[++i]!;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'usage: sql:generate [--check] [--schema path] [--dir migrationsDir] [--name init]',
          '',
          '  --check   regenerate in memory and diff against the committed migration.sql',
          '  --name    directory suffix for a new migration (default: init)',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return args;
}

/** Finds the initial migration directory, or names a new one deterministically. */
export async function resolveOutFile(args: GenerateArgs): Promise<string> {
  if (args.out) return args.out;
  const { readdir } = await import('node:fs/promises');
  let entries: string[] = [];
  try {
    entries = await readdir(args.migrationsDir);
  } catch {
    entries = [];
  }
  const suffix = args.name ?? 'init';
  const existing = entries.filter((e) => e.endsWith(`_${suffix}`)).sort();
  const dirName = existing[0] ?? `20260905120000_${suffix}`;
  return join(args.migrationsDir, dirName, 'migration.sql');
}

export async function generate(args: GenerateArgs): Promise<{ sql: string; outFile: string; written: boolean }> {
  const source = await readFile(args.schema, 'utf8');
  const parsed = parsePrismaSchema(source);
  const sql = generateMigrationSql(parsed);
  const outFile = await resolveOutFile(args);

  if (args.check) {
    let current = '';
    try {
      current = await readFile(outFile, 'utf8');
    } catch {
      current = '';
    }
    if (current !== sql) {
      const firstDiff = describeDiff(current, sql);
      throw new Error(
        [
          `${outFile} is out of date with ${args.schema}.`,
          'Run `npm run sql:generate` and commit the result.',
          firstDiff ? `\nfirst difference:\n${firstDiff}` : '',
        ].join('\n'),
      );
    }
    return { sql, outFile, written: false };
  }

  await mkdir(join(outFile, '..'), { recursive: true });
  await writeFile(outFile, sql, 'utf8');
  return { sql, outFile, written: true };
}

function describeDiff(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `  line ${i + 1}\n  committed: ${al[i] ?? '<missing>'}\n  generated: ${bl[i] ?? '<missing>'}`;
    }
  }
  return '';
}

const invokedPath = process.argv[1];
const isMain = invokedPath ? import.meta.url === pathToFileURL(invokedPath).href : false;

if (isMain) {
  const { schemaPath, migrationsDir } = await import('../env.js');
  const args = parseArgs(process.argv.slice(2), { schema: schemaPath(), migrationsDir: migrationsDir() });
  try {
    const res = await generate(args);
    const parsed = parsePrismaSchema(await readFile(args.schema, 'utf8'));
    process.stdout.write(
      `${args.check ? '✓ up to date' : '✓ written'}: ${res.outFile}\n` +
        `  ${parsed.models.length} tables · ${parsed.enums.length} enums · ${res.sql.split('\n').length} lines\n`,
    );
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
