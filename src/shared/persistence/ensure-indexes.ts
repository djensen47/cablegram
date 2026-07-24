import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';

/**
 * Creates every index the repositories rely on (ADR-012). With the native
 * driver there is no `prisma db push` to materialize indexes from a schema, so
 * we own their creation explicitly here and run it at startup (both entrypoints
 * connect once at module scope, ADR-009) and in the integration-test setup.
 *
 * `createIndexes` is idempotent — an index that already exists with the same
 * spec is a no-op — so this is safe to run on every warm boot. The index set
 * replicates exactly what the Prisma schema declared:
 *
 * - `subscriptions`: unique compound `(newsletterId, email)` — the membership
 *   key that both makes a subscription unique within a newsletter and lets a
 *   duplicate `create` be rejected (ADR-011); plus `newsletterId` for listing.
 * - `campaigns`: `newsletterId` for scoped listing.
 * - `send_records`: `campaignId`.
 * - `users`: unique `email` — one account per address (ADR-013); the login
 *   lookup and the create-user guard both key on it.
 * - `refresh_tokens`: a TTL index on `expiresAt` (`expireAfterSeconds: 0`) so
 *   Mongo reaps expired refresh tokens on its own — validity is still checked
 *   explicitly at refresh time, this is just housekeeping. The hash is the
 *   `_id`, so lookup by hash is free; plus a `userId` index so a session
 *   revocation (`deleteAllForUser`, ADR-013) — used by password reset — is a
 *   single indexed delete.
 * - `one_time_tokens`: password-reset + magic-link tokens (ADR-013/014), keyed
 *   by hash as `_id` (free lookup) with a TTL index on `expiresAt` reaping used
 *   or lapsed tokens; single-use + expiry are still enforced explicitly.
 *
 * `newsletters` and `templates` need only their `_id` index (implicit, free);
 * `suppressions` keys on the address as `_id`, so its uniqueness is free too.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(COLLECTIONS.subscriptions).createIndexes([
    { key: { newsletterId: 1, email: 1 }, unique: true },
    { key: { newsletterId: 1 } },
  ]);
  await db.collection(COLLECTIONS.campaigns).createIndexes([{ key: { newsletterId: 1 } }]);
  await db.collection(COLLECTIONS.sendRecords).createIndexes([{ key: { campaignId: 1 } }]);
  await db.collection(COLLECTIONS.users).createIndexes([{ key: { email: 1 }, unique: true }]);
  await db
    .collection(COLLECTIONS.refreshTokens)
    .createIndexes([{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }, { key: { userId: 1 } }]);
  await db
    .collection(COLLECTIONS.oneTimeTokens)
    .createIndexes([{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }, { key: { userId: 1 } }]);
}
