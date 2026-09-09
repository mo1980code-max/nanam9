import { defineConfig } from 'vitest/config';

/**
 * API tests. Two layers:
 *  · structural tests over the source (no Nest bootstrap, no database) that catch
 *    wiring mistakes TypeScript cannot see — decorator metadata, DTO imports, route
 *    ordering. These are the cheap ones and they run on every `npm test`;
 *  · HTTP-level behaviour is covered by the end-to-end smoke scripts, which need a
 *    live PostgreSQL, so they are not part of this suite.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
