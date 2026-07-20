import type { GlobalSetupContext } from 'vitest/node';
import { pushPrismaSchema, startMongoMemoryReplicaSet } from './mongo-memory.js';

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
 * Starts **one** in-memory Mongo replica set for the whole run (booting one
 * takes a few seconds; every contract test file shares it rather than paying
 * that cost per file) and syncs the Prisma schema to it once, then hands the
 * connection string to every test file via `inject('mongoUri')`.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const { uri, stop } = await startMongoMemoryReplicaSet();
  pushPrismaSchema(uri);
  provide('mongoUri', uri);
  return stop;
}
