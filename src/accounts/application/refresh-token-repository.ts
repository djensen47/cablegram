/**
 * A persisted refresh token (ADR-013): the server stores only the SHA-256
 * **hash** of the opaque secret (the hash is the id), never the secret itself.
 * `expiresAt` bounds its life; validity is checked explicitly at refresh time.
 */
export interface StoredRefreshToken {
  /** SHA-256 hash of the opaque secret — the storage key. */
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Persistence gateway for refresh tokens. Lives in `application/` next to its
 * consumers (ADR-001). Opaque-and-stored (not a self-contained signed token)
 * so logout and rotation can genuinely revoke a session — a JWT alone cannot
 * be revoked before it expires.
 */
export interface RefreshTokenRepository {
  create(token: StoredRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  /** Returns `true` if a row was deleted, `false` if none existed (idempotent logout). */
  deleteByHash(tokenHash: string): Promise<boolean>;
  /**
   * Revoke **every** session for a user by deleting all their stored refresh
   * tokens (ADR-013). Used after a password reset (and any future
   * change-password) so a credential change logs out all existing sessions.
   * Returns the number of tokens deleted.
   */
  deleteAllForUser(userId: string): Promise<number>;
}
