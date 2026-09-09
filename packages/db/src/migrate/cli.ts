/**
 * `npm run db:migrate` — apply every pending migration to DATABASE_URL.
 * `npm run db:migrate -- --reset` — drop the public schema first (never in production).
 * `npm run db:migrate -- --status` — show what is applied and what is pending.
 */

import { createConnection, ping } from '../connection.js';
import { databaseUrl, loadEnv, migrationsDir } from '../env.js';
import { appliedMigrations, ensureMigrationsTable, listMigrations, migrate, resetSchema } from './runner.js';

type Args = {
  reset: boolean;
  status: boolean;
  verbose: boolean;
  url?: string;
  dir?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { reset: false, status: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reset') args.reset = true;
    else if (a === '--status') args.status = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: db:migrate [--reset] [--status] [--url <databaseUrl>] [--dir <migrationsDir>] [--verbose]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const env = loadEnv();
  const url = databaseUrl(args.url);
  const dir = args.dir ?? migrationsDir();

  const check = await ping(url);
  if (!check.ok) {
    process.stderr.write(
      [
        '✗ cannot reach the database.',
        `  url:   ${url.replace(/:[^:@/]*@/, ':****@')}`,
        `  error: ${check.error}`,
        '',
        '  If you are developing locally, start PostgreSQL first:',
        '    npm run db:up            # zero-install PostgreSQL (WASM) on :5433',
        '    docker compose up -d db  # real PostgreSQL 16 on :5432',
        '',
      ].join('\n'),
    );
    return 1;
  }
  process.stdout.write(`✓ connected — ${check.version?.split(',')[0] ?? 'PostgreSQL'}\n`);
  if (env.loaded) process.stdout.write(`  .env: ${env.root}/.env\n`);

  const conn = createConnection({ connectionString: url, applicationName: 'voltade-migrate', max: 2 });
  try {
    if (args.status) {
      await ensureMigrationsTable(conn);
      const applied = await appliedMigrations(conn);
      const all = await listMigrations(dir);
      for (const m of all) {
        const rec = applied.get(m.name);
        const mark = rec ? (rec.checksum === m.checksum ? '✓ applied  ' : '! DRIFTED  ') : '· pending  ';
        process.stdout.write(`  ${mark} ${m.name}\n`);
      }
      if (all.length === 0) process.stdout.write(`  (no migrations found in ${dir})\n`);
      return 0;
    }

    if (args.reset) {
      if (process.env.NODE_ENV === 'production' && process.env.VOLTDE_ALLOW_RESET !== '1') {
        process.stderr.write('✗ refusing --reset with NODE_ENV=production\n');
        return 1;
      }
      process.stdout.write('· dropping schema public…\n');
      await resetSchema(conn);
    }

    const started = Date.now();
    const result = await migrate(conn, dir, {
      onApplied: (name, statements) => process.stdout.write(`✓ ${name} (${statements} statements)\n`),
      onStatement: args.verbose
        ? (_n, i, total, text) => process.stdout.write(`    [${i}/${total}] ${text.slice(0, 120).replace(/\s+/g, ' ')}\n`)
        : undefined,
    });

    if (result.checksumMismatches.length > 0) {
      for (const m of result.checksumMismatches) {
        process.stderr.write(`! ${m.name}: committed checksum ${m.actual} ≠ applied ${m.recorded}\n`);
      }
      process.stderr.write('  An applied migration was edited after the fact. Fix the file or the database.\n');
      return 1;
    }

    const ms = Date.now() - started;
    process.stdout.write(
      result.applied.length === 0
        ? `✓ already up to date (${result.skipped.length} applied, ${ms}ms)\n`
        : `✓ applied ${result.applied.length} migration(s) in ${ms}ms\n`,
    );
    return 0;
  } finally {
    await conn.close();
  }
}

const invoked = process.argv[1];
const isMain = invoked ? import.meta.url === new URL(`file://${invoked.startsWith('/') ? invoked : `/${invoked}`}`).href : false;

if (isMain || process.env.MIGRATE_CLI === '1') {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
