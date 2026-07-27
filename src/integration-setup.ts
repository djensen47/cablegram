import type { GlobalSetupContext } from 'vitest/node';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from './shared/persistence/index.js';
import { startMongoMemoryServer } from './shared/testing/index.js';
import { ALL_INDEXES } from './indexes.js';

// Typed injection (Vitest's `provide`/`inject`) rather than an env var: the
// mongo URI only needs to reach test files, not every process an env var
// would leak into, and it stays type-checked at both ends.
declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Vitest `globalSetup` for the integration run (`vitest.integration.config.ts`
 * only — the default `npm test` never loads this file, see `docs/testing.md`).
 * Starts **one** in-memory standalone Mongo for the whole run (booting one takes
 * a few seconds; every contract test file shares it rather than paying that cost
 * per file) and creates the indexes on it once (ADR-012 — the app owns index
 * creation now that Prisma's `db push` is gone), then hands the connection
 * string to every test file via `inject('mongoUri')`.
 *
 * **This file lives in `src/`, not `shared/testing/`, on purpose** (ADR-017).
 * It needs `ALL_INDEXES`, which imports every component facade, and a `shared/*`
 * module is a leaf that may not do that (ADR-005 #4). At `src/` it is an `app`
 * element — the same category as `server.ts` and `function.ts` — which is
 * exactly what it is: an entrypoint that assembles components. Moving it here is
 * what lets the integration suite create the *real* index set instead of a
 * duplicated copy that could drift from production.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const { uri, stop } = await startMongoMemoryServer();
  const client = new MongoClient(uri);
  await client.connect();
  await ensureIndexes(client.db(), ALL_INDEXES);
  await client.close();
  provide('mongoUri', uri);
  return stop;
}
