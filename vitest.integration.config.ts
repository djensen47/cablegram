import { defineConfig } from 'vitest/config';

// The integration suite (`npm run test:integration`), kept separate from the
// default `npm test` so that suite stays fast and DB-free (docs/testing.md).
// Runs the Mongo repository **contract tests** — the same behavioral contract
// the InMemory doubles are asserted against in the default suite — against a
// real `mongod` (a bare standalone; the native driver needs no replica set,
// ADR-012) started once for the whole run by `globalSetup` and shared across
// every contract test file via `inject('mongoUri')`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['./src/shared/testing/global-setup.ts'],
    // `mongodb-memory-server` downloads the `mongod` binary on first run
    // (cached afterwards) and starting it takes a few seconds; the default 5s
    // hook/test timeouts are too tight for that.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // One global `mongod`, shared by every file — run them serially so
    // `afterEach` cleanup in one file can't race a concurrent file's writes.
    fileParallelism: false,
  },
});
