import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One shared Postgres; files create their own businesses so they can run in parallel.
    fileParallelism: true,
  },
});
