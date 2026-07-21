import type { GlobalSetupContext } from 'vitest/node';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from '../persistence/index.js';
import { startMongoMemoryServer } from './mongo-memory.js';

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
 * Starts **one** in-memory standalone Mongo for the whole run (booting one
 * takes a few seconds; every contract test file shares it rather than paying
 * that cost per file) and creates the indexes on it once (ADR-012 — the app
 * owns index creation now that Prisma's `db push` is gone), then hands the
 * connection string to every test file via `inject('mongoUri')`.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const { uri, stop } = await startMongoMemoryServer();
  const client = new MongoClient(uri);
  await client.connect();
  await ensureIndexes(client.db());
  await client.close();
  provide('mongoUri', uri);
  return stop;
}
