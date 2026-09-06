import { defineConfig } from 'vitest/config';

/**
 * Two kinds of test live here:
 *  · unit tests for the SQL builder and the schema tools (no database, ~1 s);
 *  · parity tests that boot a real PostgreSQL in-process (PGlite = the actual
 *    engine compiled to WASM), apply the committed migrations and compare the
 *    resulting information_schema with prisma/schema.prisma.
 *
 * The parity tests are what makes "schema-first Prisma" safe without a Prisma
 * engine binary: if the SQL and the schema drift, CI fails with the exact column
 * that drifted. They are skipped (not failed) when PGlite cannot be loaded.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    sequence: { concurrent: false },
  },
});
