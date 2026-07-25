import type { StoredCredentials } from './credential-store.js';

/**
 * Session helpers (ADR-016). The API returns `expiresIn` seconds; everything
 * downstream wants an absolute instant, and `whoami` wants the claims.
 */

/** The wire shape of `POST /v1/auth/login` and `/auth/refresh` responses. */
export interface SessionResponse {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** The claims cablegram puts in an access token (ADR-013): `sub` + `role` + `exp`. */
export interface TokenClaims {
  userId: string;
  role: string;
  /** Expiry as an absolute instant, or null if the token carried no `exp`. */
  expiresAt: Date | null;
}

/** Folds a fresh session into the stored credentials, resolving `expiresIn`. */
export function credentialsFromSession(
  baseUrl: string,
  session: SessionResponse,
  now: Date,
): StoredCredentials {
  return {
    baseUrl,
    accessToken: session.accessToken,
    accessTokenExpiresAt: new Date(now.getTime() + session.expiresIn * 1000).toISOString(),
    refreshToken: session.refreshToken,
  };
}

/**
 * Reads the claims out of an access token **without verifying its signature**.
 *
 * That is not a shortcut — the CLI structurally cannot verify: `JWT_SECRET` is a
 * server secret and never leaves the deployment (ADR-016 §1). The decoded claims
 * are therefore only ever used to *display* who you are (`whoami`) and to decide
 * whether to pre-emptively refresh. They are never a security decision: the
 * server re-verifies on every request, and a tampered local token simply earns a
 * 401. Returns null for anything that is not a well-formed JWT.
 */
export function decodeClaims(accessToken: string): TokenClaims | null {
  const segments = accessToken.split('.');
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) return null;

  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    const { sub, role, exp } = claims;
    if (typeof sub !== 'string') return null;
    return {
      userId: sub,
      role: typeof role === 'string' ? role : 'unknown',
      expiresAt: typeof exp === 'number' ? new Date(exp * 1000) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the stored access token is expired (or close enough that it would
 * expire mid-flight). The skew avoids the race where a token passes this check
 * and is rejected by the time the request lands.
 */
const EXPIRY_SKEW_MS = 30_000;

export function isAccessTokenExpired(credentials: StoredCredentials, now: Date): boolean {
  if (credentials.accessTokenExpiresAt === undefined) return true;
  const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - EXPIRY_SKEW_MS <= now.getTime();
}
