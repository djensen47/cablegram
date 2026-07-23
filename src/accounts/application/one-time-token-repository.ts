/**
 * What a one-time email token authorizes (ADR-013/014). A single generic store
 * backs both flows rather than two near-identical collections; the `purpose`
 * discriminates them so a token minted for one flow can never be consumed by the
 * other (the consuming use case checks it).
 */
export type OneTimeTokenPurpose = 'password-reset' | 'magic-link';

/**
 * A persisted one-time token: the server stores only the SHA-256 **hash** of the
 * opaque secret (the hash is the id), never the secret itself — structurally the
 * same posture as a refresh token. `expiresAt` bounds its life and `purpose`
 * scopes it; both are checked explicitly at consume time, and the token is
 * deleted on use (single-use).
 */
export interface StoredOneTimeToken {
  /** SHA-256 hash of the opaque secret — the storage key. */
  tokenHash: string;
  userId: string;
  purpose: OneTimeTokenPurpose;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Persistence gateway for one-time email tokens (password-reset, magic-link).
 * Lives in `application/` next to its consumers (ADR-001); the MongoDB native
 * driver is one implementation behind it (ADR-012), the in-memory double
 * another. Opaque-and-stored so a token can be genuinely consumed (deleted),
 * exactly like the refresh-token store.
 */
export interface OneTimeTokenRepository {
  create(token: StoredOneTimeToken): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredOneTimeToken | null>;
  /** Returns `true` if a row was deleted, `false` if none existed. */
  deleteByHash(tokenHash: string): Promise<boolean>;
}
