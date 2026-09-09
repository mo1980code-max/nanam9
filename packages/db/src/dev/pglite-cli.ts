/**
 * `npm run db:up` — start PostgreSQL-in-WASM, then (with --setup) migrate it.
 *
 * This is the "it just works" entry point for a fresh clone:
 *
 *   npm install && npm run build:packages && npm run db:up -- --setup && npm run db:seed
 *
 * No Docker, no system packages, no database admin. The same commands work
 * against a real PostgreSQL 16 by setting DATABASE_URL — the CLI only falls back
 * to PGlite when DATABASE_URL is absent or points at the local dev port.
 */

import { ping } from '../connection.js';
import { loadEnv } from '../env.js';
import { main as migrateMain } from '../migrate/cli.js';
import { startPgliteServer } from './pglite-server.js';

type Args = {
  port?: number;
  host?: string;
  data?: string;
  setup: boolean;
  reset: boolean;
  seed: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { setup: false, reset: false, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--setup') args.setup = true;
    else if (a === '--reset') {
      args.reset = true;
      args.setup = true;
    } else if (a === '--seed') args.seed = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'usage: db:up [--port 5433] [--host 127.0.0.1] [--data .var/pglite] [--setup] [--reset] [--seed]',
          '',
          '  --setup   run migrations as soon as the server accepts connections',
          '  --reset   drop the schema and migrate from scratch',
          '  --seed    seed demo content after migrating (implies --setup)',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  if (args.seed) args.setup = true;
  return args;
}

async function waitReady(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ping(url, 2000);
    if (res.ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const server = await startPgliteServer({
    port: args.port,
    host: args.host,
    dataDir: args.data,
  });

  // Make the URL visible to every other npm script in the workspace.
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? server.url;

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n· ${signal} — stopping PostgreSQL (WASM)…\n`);
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (args.setup) {
    if (!(await waitReady(server.url))) {
      process.stderr.write('✗ server did not accept connections in time\n');
      await server.stop();
      process.exit(1);
    }
    const migrateArgs = ['--url', server.url];
    if (args.reset) migrateArgs.push('--reset');
    const code = await migrateMain(migrateArgs);
    if (code !== 0) {
      await server.stop();
      process.exit(code);
    }
    if (args.seed) {
      const { main: seedMain } = await import('../seed/cli.js');
      const seeded = await seedMain(['--url', server.url]);
      if (seeded !== 0) {
        await server.stop();
        process.exit(seeded);
      }
    }
    process.stdout.write('\n✓ ready. Start the stack with:  npm run dev\n\n');
  }

  // Keep the process alive: this is a server.
  await new Promise<void>(() => undefined);
}

const invoked = process.argv[1];
const isMain = invoked ? import.meta.url === new URL(`file://${invoked.startsWith('/') ? invoked : `/${invoked}`}`).href : false;

if (isMain || process.env.PGLITE_CLI === '1') {
  main().catch(async (err) => {
    process.stderr.write(`✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
