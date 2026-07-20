import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestId, requestLogging } from './request-id.js';

describe('requestId + requestLogging', () => {
  let app: Hono;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    app = new Hono();
    app.use('*', requestId);
    app.use('*', requestLogging);
    app.get('/ok', (c) => c.json({ ok: true }, 200));
    app.get('/boom', (c) => c.json({ error: true }, 500));
  });

  it('assigns and echoes an X-Request-Id header', async () => {
    const res = await app.request('/ok');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('echoes a caller-supplied X-Request-Id instead of generating one', async () => {
    const res = await app.request('/ok', { headers: { 'x-request-id': 'caller-id' } });
    expect(res.headers.get('x-request-id')).toBe('caller-id');
  });

  it('emits one structured JSON log line per request, correlated by requestId', async () => {
    await app.request('/ok', { headers: { 'x-request-id': 'caller-id' } });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      event: 'request',
      requestId: 'caller-id',
      method: 'GET',
      path: '/ok',
      status: 200,
    });
    expect(typeof line.durationMs).toBe('number');
  });

  it('logs at "error" level for a 5xx response', async () => {
    await app.request('/boom');
    const line = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', status: 500 });
  });
});
