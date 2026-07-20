import { timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './app-env.js';
import { UnauthorizedError } from './errors.js';

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Single-tenant API-key auth (ADR-004, ADR-010). Accepts `Authorization:
 * Bearer <key>` or `X-Api-Key: <key>` and checks it against the configured
 * keys with a constant-time comparison.
 */
export function apiKeyAuth(keys: readonly string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.req.header('authorization');
    const presented =
      auth && auth.toLowerCase().startsWith('bearer ')
        ? auth.slice('bearer '.length).trim()
        : c.req.header('x-api-key');

    if (!presented || !keys.some((k) => safeEquals(k, presented))) {
      throw new UnauthorizedError();
    }
    await next();
  });
}
