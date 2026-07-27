import type { CollectionIndexes } from '../../shared/persistence/index.js';

/** The collections `accounts` owns, and their indexes (ADR-013/014, ADR-017). */
export const ACCOUNT_COLLECTIONS = {
  users: 'account_users',
  refreshTokens: 'account_refresh_tokens',
  oneTimeTokens: 'account_one_time_tokens',
} as const;

// Both token collections key on the token **hash** as `_id`, so lookup by hash
// is free and needs no declared index. What they do need is a TTL sweep and a
// `userId` index — the latter is what makes revoking every session for a user
// (password reset, ADR-013) a single indexed delete rather than a scan.
const tokenIndexes = [
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  { key: { userId: 1 } },
] as const;

export const accountIndexes: CollectionIndexes[] = [
  // One account per address (ADR-013): both the login lookup and the
  // create-user guard key on it, and uniqueness is enforced by the store.
  { collection: ACCOUNT_COLLECTIONS.users, indexes: [{ key: { email: 1 }, unique: true }] },
  // TTL only reaps; single-use and expiry are still checked explicitly, since
  // Mongo's TTL sweep runs on its own schedule and is not a security boundary.
  { collection: ACCOUNT_COLLECTIONS.refreshTokens, indexes: [...tokenIndexes] },
  { collection: ACCOUNT_COLLECTIONS.oneTimeTokens, indexes: [...tokenIndexes] },
];
