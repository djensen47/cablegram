import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './app-env.js';

/** Assigns (or echoes) an `X-Request-Id` for correlation across logs. */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = c.req.header('x-request-id') ?? randomUUID();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
});

/**
 * One structured (JSON, one line per event) log entry to stdout — the shape
 * every request/error log line shares. Plain `console.log`/`stdout` is the
 * only log sink an ephemeral function has (ADR-009: no local disk, no
 * in-process aggregator); JSON lines are what a platform's log collector
 * (DO's, or `docker logs`) expects to parse and index by field.
 */
export function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

/**
 * One structured log line per request: method, path, status and duration,
 * correlated to the rest of that request's logs via `requestId` (so it must
 * run after `requestId` in the middleware chain). Emitted after the handler
 * settles — including when it settled via `onError` (ADR-004) — so it always
 * carries the final status, never a guess made before the handler ran.
 */
export const requestLogging = createMiddleware<AppEnv>(async (c, next) => {
  const startedAt = Date.now();
  await next();
  logLine({
    level: c.res.status >= 500 ? 'error' : 'info',
    event: 'request',
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});
