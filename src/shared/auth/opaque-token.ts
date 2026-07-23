import { createHash, randomBytes } from 'node:crypto';

/**
 * Mint a fresh opaque token secret: 256 bits of randomness, URL-safe base64.
 * This raw value is handed to the client **once** (a refresh token, a
 * password-reset link, a magic-link) and only its hash is persisted, so the raw
 * secret never touches the database. One minting path for every opaque credential
 * cablegram issues — the same convention `shared/ids`' `newId()` follows.
 */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The storage key for an opaque token: a SHA-256 digest of the secret. The
 * server stores only this digest, so a database leak cannot yield usable tokens;
 * the consuming flow re-hashes the presented secret to find the row. SHA-256
 * (not a slow KDF) is correct here — the input is already high-entropy random,
 * so there is nothing to brute-force.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
