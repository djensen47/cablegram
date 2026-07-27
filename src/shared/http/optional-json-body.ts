import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './app-env.js';

/**
 * Lets a route declare a JSON body that callers may omit entirely.
 *
 * Hono's validator parses the body whenever `content-type: application/json` is
 * present and throws `Malformed JSON in request body` on an empty one — before
 * zod runs, so `required: false` does not help and neither does an all-optional
 * schema. A client that sets the header and sends nothing (which most HTTP
 * libraries do on a bodyless POST) would get a 500.
 *
 * That matters here because the routes gaining an optional body — confirm and
 * unsubscribe — already exist and are called with no body today. Substituting
 * `{}` keeps those callers working while still letting the route declare its
 * schema, so the OpenAPI document keeps describing the fields (ADR-004: the
 * contract is the product). The alternative, hand-parsing in the handler, would
 * have bought the same tolerance by deleting the schema from the spec.
 */
export const optionalJsonBody = createMiddleware<AppEnv>(async (c, next) => {
  const isJson = c.req.header('content-type')?.includes('application/json') === true;
  if (isJson && (await c.req.raw.clone().text()).trim() === '') {
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: '{}',
    });
  }
  await next();
});
