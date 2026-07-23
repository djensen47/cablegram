import { createHash, randomBytes } from 'node:crypto';

/**
 * Mint a fresh opaque refresh-token secret (ADR-013): 256 bits of randomness,
 * URL-safe base64. This raw value is handed to the client **once**; only its
 * hash is persisted, so the raw secret never touches the database. Called
 * directly by the accounts use cases — the same convention `shared/ids`'
 * `newId()` follows for random identifiers.
 */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The storage key for a refresh token: a SHA-256 digest of the opaque secret.
 * The server stores only this digest, so a database leak cannot yield usable
 * refresh tokens; login/refresh/logout re-hash the presented secret to find
 * the row. SHA-256 (not a slow KDF) is correct here — the input is already
 * high-entropy random, so there is nothing to brute-force.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
