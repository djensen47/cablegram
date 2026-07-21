import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Integration-test-only infrastructure (never imported by production code —
 * `shared/testing` is still a boundaries-legal leaf, ADR-005 #4: it imports no
 * domain component). Backs the Mongo repository **contract tests**
 * (`*.integration.test.ts`, run only via `npm run test:integration`, never the
 * default `npm test` — see `docs/testing.md`).
 *
 * Starts a real `mongod` as a **standalone** via `mongodb-memory-server` (the
 * binary is downloaded once and cached under `~/.cache/mongodb-binaries`;
 * CI-friendly, no Docker). A standalone — not a replica set — because the
 * native driver plus cablegram's single-document, no-transaction writes
 * (ADR-012) need no replica set; the contract tests pass against a bare
 * standalone, which is proof the app needs no replica-set topology in
 * production either (ADR-012 records this finding).
 */
export async function startMongoMemoryServer(): Promise<{
  uri: string;
  stop: () => Promise<void>;
}> {
  const server = await MongoMemoryServer.create();
  return {
    uri: server.getUri('cablegram'),
    stop: async () => {
      await server.stop();
    },
  };
}
