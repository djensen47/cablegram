import { describe, expect, it } from 'vitest';
import { buildContainer } from './shared/di/index.js';
import { TEST_ENV, bearerHeaders } from './shared/testing/index.js';
import { createApp } from './app.js';

describe('app', () => {
  const app = createApp(buildContainer(TEST_ENV));

  it('serves an open health check', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'cablegram' });
  });

  it('rejects /v1 without a JWT', async () => {
    const res = await app.request('/v1/anything');
    expect(res.status).toBe(401);
  });

  it('passes /v1 auth with a valid token (then 404, no route)', async () => {
    const res = await app.request('/v1/anything', { headers: await bearerHeaders() });
    expect(res.status).toBe(404);
  });

  it('leaves the setup + auth endpoints open (no token needed to reach them)', async () => {
    // An invalid body reaches edge validation (400) rather than being turned
    // away 401 — proof the route is open, without touching the database.
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('validation_error');
  });

  it('advertises the Bearer JWT security scheme (not an API key)', async () => {
    const res = await app.request('/openapi.json');
    const doc = (await res.json()) as {
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.components?.securitySchemes).toHaveProperty('BearerAuth');
    expect(doc.components?.securitySchemes).not.toHaveProperty('ApiKeyAuth');
  });
});
