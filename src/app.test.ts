import { describe, expect, it } from 'vitest';
import { buildContainer } from './shared/di/index.js';
import { createApp } from './app.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

describe('app', () => {
  const app = createApp(buildContainer(env));

  it('serves an open health check', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'cablegram' });
  });

  it('rejects /v1 without an API key', async () => {
    const res = await app.request('/v1/anything');
    expect(res.status).toBe(401);
  });

  it('passes /v1 auth with a valid key (then 404, no route yet)', async () => {
    const res = await app.request('/v1/anything', { headers: { 'x-api-key': 'k1' } });
    expect(res.status).toBe(404);
  });
});
