import 'reflect-metadata';
import { loadConfig } from '../config/index.js';
import { DefaultClock } from '../clock/index.js';
import { JoseAccessTokenService, type AccessClaims } from '../auth/index.js';

/**
 * Test-only HTTP auth helpers (ADR-013). `/v1` is JWT-only now, so route tests
 * need a valid Bearer token instead of the old `x-api-key`. These mint a real
 * access token with the same `JoseAccessTokenService` + secret the app under
 * test verifies with (`TEST_ENV`), so there is zero drift from production
 * signing/verifying. Never imported by production code — a `shared/testing` leaf.
 */

/** A signing secret long enough to satisfy the config's 32-char minimum. */
export const TEST_JWT_SECRET = 'test-jwt-secret-please-use-32+-characters!!';

/** The canonical env every unit/route test builds its container from. */
export const TEST_ENV = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: TEST_JWT_SECRET,
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
} as NodeJS.ProcessEnv;

/** Mint a signed access token for the given claims (defaults to an admin). */
export async function bearerToken(
  claims: AccessClaims = { userId: 'test-admin', role: 'admin' },
): Promise<string> {
  const service = new JoseAccessTokenService(loadConfig(TEST_ENV), new DefaultClock());
  return service.issueAccessToken(claims);
}

/** Request headers carrying a Bearer token (defaults to an admin) plus JSON content type. */
export async function bearerHeaders(claims?: AccessClaims): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await bearerToken(claims)}`,
    'content-type': 'application/json',
  };
}
