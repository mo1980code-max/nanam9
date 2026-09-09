import { defineConfig } from 'vitest/config';

/**
 * @voltade/shared is isomorphic and dependency-free, so its tests are pure unit
 * tests: no database, no HTTP, no Nest bootstrap. They run in well under a second
 * and are the place where security-critical helpers (HTML sanitisation, URL guards,
 * slug rules) are pinned, because those are the functions the API *and* the web app
 * both trust.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
