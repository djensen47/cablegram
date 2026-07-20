import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { StatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './app-env.js';
import { ConflictError } from './errors.js';
import type { IdempotencyStore } from './idempotency-store.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';

function fingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * `Idempotency-Key` support for mutating POST routes (the Stripe-style REST
 * convention). Strictly opt-in: a request without the header passes through
 * unchanged, so it never alters behavior for an existing caller. With the
 * header present, the **first** call for a given `(method, path, key)` runs
 * normally and its response is cached; a **replay** with the same key returns
 * the cached response without re-running the handler — so a client's
 * at-least-once retry over a flaky connection (e.g. a `POST .../send` whose
 * response never arrived) cannot re-trigger the side effect. Reusing a key
 * with a *different* request body is treated as a client bug, not silently
 * replayed or re-executed — it's rejected as a conflict.
 *
 * Mount on the POST-capable surface that should honor it (`app.ts` mounts it
 * on the whole `/v1` router). Storage is a swap seam — see `IdempotencyStore`.
 */
export function idempotencyKey(store: IdempotencyStore) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== 'POST') {
      await next();
      return;
    }
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (!key) {
      await next();
      return;
    }

    // Clone the raw request before reading its body: `c.req`'s body stream can
    // only be consumed once, and the route handler still needs to read it via
    // `c.req.valid('json')` downstream.
    const bodyText = await c.req.raw.clone().text();
    const fp = fingerprint(bodyText);
    const cacheKey = `${c.req.method} ${c.req.path} ${key}`;

    const cached = await store.get(cacheKey);
    if (cached) {
      if (cached.fingerprint !== fp) {
        throw new ConflictError('Idempotency-Key reused with a different request body');
      }
      return c.newResponse(
        cached.body,
        cached.status as StatusCode,
        cached.contentType ? { 'content-type': cached.contentType } : undefined,
      );
    }

    await next();

    if (c.res) {
      const body = await c.res.clone().text();
      await store.set(cacheKey, {
        fingerprint: fp,
        status: c.res.status,
        contentType: c.res.headers.get('content-type') ?? undefined,
        body,
      });
    }
  });
}
