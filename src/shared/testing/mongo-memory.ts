import { execFileSync } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Integration-test-only infrastructure (never imported by production code —
 * `shared/testing` is still a boundaries-legal leaf, ADR-005 #4: it imports no
 * domain component). Backs the Prisma repository **contract tests**
 * (`*.integration.test.ts`, run only via `npm run test:integration`, never the
 * default `npm test` — see `docs/testing.md`).
 *
 * Starts a real `mongod` as a single-node replica set via
 * `mongodb-memory-server` (the binary is downloaded once and cached under
 * `~/.cache/mongodb-binaries`; CI-friendly, no Docker). A replica set — not a
 * bare standalone — because Prisma's MongoDB connector requires one (ADR-007
 * documents this for the target deployment; contract tests need the same
 * topology to be a faithful stand-in).
 */
export async function startMongoMemoryReplicaSet(): Promise<{
  uri: string;
  stop: () => Promise<void>;
}> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await replSet.waitUntilRunning();
  return {
    uri: replSet.getUri('cablegram'),
    stop: async () => {
      await replSet.stop();
    },
  };
}

/**
 * Syncs `prisma/schema.prisma` to the target database. MongoDB has no
 * migration files (ADR-007) — `prisma db push` is the documented sync path,
 * run once here before any contract test connects, so unique indexes
 * (e.g. subscriptions' compound `(newsletterId, email)`) actually exist to
 * enforce the constraints the contract tests check.
 */
export function pushPrismaSchema(databaseUrl: string): void {
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
