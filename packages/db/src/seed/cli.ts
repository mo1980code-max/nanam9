#!/usr/bin/env node
/**
 * `npm run db:seed` — fill a database with everything a Voltade install needs
 * before it can serve a page: RBAC, settings, themes, homepage sections, an
 * admin account, the demo catalogue (optional), CMS content and ad placements.
 *
 * Design rules:
 *  · Idempotent. Every row is matched on a natural key and upserted, so running
 *    this twice on the same database is a no-op rather than a duplicate storm.
 *  · Migrations first. Seeding an unmigrated database produces a wall of
 *    "relation does not exist", so by default we apply pending migrations in the
 *    same process (`--no-migrate` opts out for CI images that already migrated).
 *  · Never invent an admin password. If SEED_ADMIN_PASSWORD is not set we
 *    generate one, print it once, and store only the Argon2id hash.
 *  · Never print secrets to a log aggregator by accident: `--quiet` suppresses
 *    the password line for automated runs (use SEED_ADMIN_PASSWORD there).
 */

import { loadEnv, databaseUrl, migrationsDir } from '../env.js';
import { connectDatabase } from '../index.js';
import { migrate as runMigrations, resetSchema, introspect } from '../migrate/runner.js';
import { seedDatabase } from './content.js';
import type { Connection } from '../connection.js';

type Args = {
  url?: string;
  migrate: boolean;
  reset: boolean;
  demo?: boolean;
  adminEmail?: string;
  adminUsername?: string;
  quiet: boolean;
  json: boolean;
  help: boolean;
};

const USAGE = `
voltade db:seed — seed a database

  --url=<postgres-url>   connection string (default: $DATABASE_URL, then the dev PGlite URL)
  --no-migrate           skip applying pending migrations first
  --reset                DROP everything and rebuild before seeding  ⚠ destroys data
  --demo / --no-demo     include the demo catalogue (default: on unless SEED_DEMO_CONTENT=0)
  --admin-email=<e>      admin account email      (default: $SEED_ADMIN_EMAIL or admin@voltade.test)
  --admin-username=<u>   admin account username   (default: admin)
  --quiet                don't print the generated admin password
  --json                 machine-readable summary, nothing else
  --help

Environment:
  SEED_ADMIN_PASSWORD    if set (>= 8 chars) it is used verbatim, otherwise a
                         strong password is generated and printed once.
  SEED_DEMO_CONTENT=0    production default: settings/RBAC/CMS only, no fake games.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { migrate: true, reset: false, quiet: false, json: false, help: false };
  for (const raw of argv) {
    const [flag, value] = raw.startsWith('--') ? raw.slice(2).split('=') : [raw, undefined];
    switch (flag) {
      case 'url': args.url = value; break;
      case 'database-url': args.url = value; break;
      case 'migrate': args.migrate = value !== 'false'; break;
      case 'no-migrate': args.migrate = false; break;
      case 'reset': args.reset = true; break;
      case 'demo': args.demo = true; break;
      case 'no-demo': args.demo = false; break;
      case 'admin-email': args.adminEmail = value; break;
      case 'admin-username': args.adminUsername = value; break;
      case 'quiet': case 'q': args.quiet = true; break;
      case 'json': args.json = true; break;
      case 'help': case 'h': args.help = true; break;
      default:
        if (!flag) continue;
        process.stderr.write(`unknown flag: --${flag}\n`);
        args.help = true;
    }
  }
  if (process.env.SEED_DEMO_CONTENT === '0' && args.demo === undefined) args.demo = false;
  return args;
}

const say = (args: Args, line: string) => {
  if (!args.quiet && !args.json) process.stdout.write(`${line}\n`);
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  loadEnv();
  const url = databaseUrl(args.url);
  const started = Date.now();

  const { db, conn } = await connectDatabase({ connectionString: url, applicationName: 'voltade-seed' });
  try {
    if (args.reset) {
      say(args, '⟲ resetting schema (DROP … CASCADE on every voltade object)…');
      await resetSchema(conn);
    }
    if (args.migrate) {
      const result = await runMigrations(conn, migrationsDir(), {
        onApplied: (name, statements) => say(args, `  ↻ ${name} (${statements} statements)`),
      });
      if (result.checksumMismatches.length > 0) {
        throw new Error(
          `applied migrations were edited on disk: ${result.checksumMismatches.map((m) => m.name).join(', ')}. ` +
            'A migration is immutable once applied — write a new one instead.',
        );
      }
      say(args, `✓ migrations: ${result.applied.length} applied, ${result.skipped.length} already recorded`);
    }

    const before = await introspect(conn);
    const out = await seedDatabase(db, {
      demo: args.demo,
      adminEmail: args.adminEmail,
      adminUsername: args.adminUsername,
      baseUrl: process.env.APP_URL,
      onLog: (line) => say(args, `  · ${line}`),
    });

    const after = await introspect(conn);
    const counts = await rowCounts(conn);
    const tableCount = Object.keys(after.tables).length;
    const summary = {
      ok: true,
      url: redact(url),
      tables: tableCount,
      newTables: tableCount - Object.keys(before.tables).length,
      demo: args.demo ?? true,
      admin: {
        email: args.adminEmail ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@voltade.test',
        username: args.adminUsername ?? 'admin',
        passwordGenerated: Boolean(out.adminPassword),
      },
      counts,
      ms: Date.now() - started,
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...summary, adminPassword: out.adminPassword ?? null }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write('\n');
    for (const [table, n] of Object.entries(counts)) {
      process.stdout.write(`  ${String(n).padStart(6)}  ${table}\n`);
    }
    process.stdout.write(`\n✓ seeded ${tableCount} tables in ${summary.ms} ms\n`);

    if (out.adminPassword) {
      process.stdout.write(
        [
          '',
          '┌──────────────────────────────────────────────────────────┐',
          '│  Admin account created with a GENERATED password         │',
          `│  ${summary.admin.email.padEnd(56)}│`,
          `│  ${(out.adminPassword ?? '').padEnd(56)}│`,
          '│  This is the only time it is shown — it is stored as an  │',
          '│  Argon2id hash. Set SEED_ADMIN_PASSWORD to choose one.   │',
          '└──────────────────────────────────────────────────────────┘',
          '',
        ].join('\n'),
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n✗ seed failed: ${message}\n`);
    if (process.env.SEED_DEBUG && error instanceof Error) process.stderr.write(`${error.stack ?? ''}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    return 1;
  } finally {
    await db.close().catch(() => {});
    await conn.close().catch(() => {});
  }
}

/** Counts that prove the seed did something — also a cheap smoke test. */
async function rowCounts(conn: Connection): Promise<Record<string, number>> {
  const tables = [
    'roles', 'permissions', 'users', 'categories', 'tags', 'games', 'game_categories', 'game_tags',
    'comments', 'ratings', 'likes', 'favorites', 'playlists', 'game_plays', 'daily_stats',
    'achievements', 'pages', 'blog_posts', 'blog_categories', 'settings', 'sections', 'themes',
    'ads', 'plans', 'subscriptions', 'providers', 'provider_items', 'import_jobs', 'redirects',
    'releases', 'activity_logs', 'notifications',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    // Quoted identifier + a table that may not exist in an older schema: guard
    // with to_regclass rather than trusting the list.
    const n = await conn.value<number>(
      `SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %s', $1), false, true, '')))[1]::text::int END`,
      [t],
    );
    if (n !== null) out[t] = n;
  }
  return out;
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••••@');
}

const invokedDirectly = process.argv[1] && (process.argv[1].endsWith('seed/cli.js') || process.argv[1].endsWith('seed/cli.ts'));
if (invokedDirectly) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
