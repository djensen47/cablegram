import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../application/api-error.js';
import type { CredentialStore, StoredCredentials } from '../application/credential-store.js';
import { FetchApiClient } from './fetch-api-client.js';

/**
 * The CLI's transport contract (ADR-016). What matters here is the behavior an
 * operator would otherwise hit as a bug: silent session expiry, a double-spent
 * refresh token, or a `fetch` rejection escaping as a stack trace.
 */

const NOW = new Date('2026-07-25T12:00:00.000Z');
const FUTURE = new Date('2026-07-25T12:15:00.000Z').toISOString();
const PAST = new Date('2026-07-25T11:00:00.000Z').toISOString();

function inMemoryStore(): CredentialStore & { saved: StoredCredentials[] } {
  const saved: StoredCredentials[] = [];
  return {
    saved,
    load: async () => saved[saved.length - 1] ?? null,
    save: async (c) => {
      saved.push(c);
    },
    clear: async () => {
      saved.length = 0;
    },
    location: () => '(memory)',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function credentials(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    baseUrl: 'https://api.example.com',
    accessToken: 'access-1',
    accessTokenExpiresAt: FUTURE,
    refreshToken: 'refresh-1',
    ...overrides,
  };
}

describe('FetchApiClient', () => {
  it('sends the bearer token and parses the JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: 'n1' }));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    const result = await client.get<{ id: string }>('/v1/newsletters/n1');

    expect(result).toEqual({ id: 'n1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.com/v1/newsletters/n1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
  });

  it('omits undefined query parameters rather than sending them empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [], meta: { nextCursor: null } }));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await client.get('/v1/subscriptions', { limit: 20, status: undefined, tag: 'vip' });

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('tag')).toBe('vip');
    expect(url.searchParams.has('status')).toBe(false);
  });

  it('refreshes and retries once on a 401, persisting the rotated tokens', async () => {
    const store = inMemoryStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(
        json({ tokenType: 'Bearer', accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }),
      )
      .mockResolvedValueOnce(json({ id: 'n1' }));

    const client = new FetchApiClient(credentials(), store, () => NOW, fetchImpl);
    const result = await client.get<{ id: string }>('/v1/newsletters/n1');

    expect(result).toEqual({ id: 'n1' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // The retry must carry the NEW token, or the refresh accomplished nothing.
    const retryHeaders = fetchImpl.mock.calls[2]![1].headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe('Bearer access-2');

    // Refresh tokens rotate (ADR-013) — the new one must be persisted or the
    // next invocation presents an already-consumed token.
    expect(store.saved.at(-1)?.refreshToken).toBe('refresh-2');
  });

  it('refreshes pre-emptively when the stored token has already expired', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ tokenType: 'Bearer', accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }),
      )
      .mockResolvedValueOnce(json({ id: 'n1' }));

    const client = new FetchApiClient(
      credentials({ accessTokenExpiresAt: PAST }),
      inMemoryStore(),
      () => NOW,
      fetchImpl,
    );
    await client.get('/v1/newsletters/n1');

    // Two calls, not three: no wasted round trip to be told what we already knew.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/v1/auth/refresh');
  });

  it('does not loop when the retried request also returns 401', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(
        json({ tokenType: 'Bearer', accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }),
      )
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'Nope' } }, 401));

    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await expect(client.get('/v1/newsletters')).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('clears the dead session and explains when the refresh token is rejected', async () => {
    const store = inMemoryStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401));

    const client = new FetchApiClient(credentials(), store, () => NOW, fetchImpl);

    await expect(client.get('/v1/newsletters')).rejects.toThrow(/session has expired/i);
    // The revoked token is dropped, so the next command says "log in" rather
    // than failing again in a more confusing way.
    expect(store.saved.at(-1)?.refreshToken).toBeUndefined();
  });

  it('refreshes only once when concurrent requests both hit a 401', async () => {
    let refreshes = 0;
    const fetchImpl: typeof fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('/auth/refresh')) {
        refreshes += 1;
        return json({
          tokenType: 'Bearer',
          accessToken: 'access-2',
          refreshToken: `refresh-${refreshes + 1}`,
          expiresIn: 900,
        });
      }
      return json({ error: { code: 'unauthorized' } }, 401);
    });

    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await Promise.allSettled([client.get('/v1/newsletters'), client.get('/v1/campaigns')]);

    // A second exchange would present an already-rotated (consumed) token.
    expect(refreshes).toBe(1);
  });

  it('maps the API error envelope onto ApiError, preserving code and requestId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(
        { error: { code: 'not_found', message: 'Newsletter not found', requestId: 'req-7' } },
        404,
      ),
    );
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await expect(client.get('/v1/newsletters/missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Newsletter not found',
      requestId: 'req-7',
    });
  });

  it('survives a non-JSON error body from a proxy', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    const err = await client.get('/v1/newsletters').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });

  it('wraps a transport failure instead of leaking the fetch rejection', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    const err = await client.get('/v1/newsletters').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isTransport).toBe(true);
    expect((err as ApiError).message).toContain('https://api.example.com');
  });

  it('resolves DELETE (204, no body) to void', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await expect(client.delete('/v1/newsletters/n1')).resolves.toBeUndefined();
  });

  it('follows nextCursor to the end in listAll', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: 'a' }], meta: { nextCursor: 'a' } }))
      .mockResolvedValueOnce(json({ data: [{ id: 'b' }], meta: { nextCursor: 'b' } }))
      .mockResolvedValueOnce(json({ data: [{ id: 'c' }], meta: { nextCursor: null } }));

    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);
    const all = await client.listAll<{ id: string }>('/v1/newsletters');

    expect(all.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get('cursor')).toBe('a');
  });

  it('never sends the bearer token on an anonymous request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ tokenType: 'Bearer' }));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await client.post('/v1/auth/login', { email: 'a@b.co' }, { anonymous: true });

    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('never attempts a refresh for a directly-supplied token (the CI path)', async () => {
    // CABLEGRAM_TOKEN arrives with no refresh token and no expiry. Treating a
    // missing expiry as "expired" used to trigger a refresh that could not
    // succeed, turning any failure into a misleading "not logged in".
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { code: 'unauthorized' } }, 401));
    const client = new FetchApiClient(
      { baseUrl: 'https://api.example.com', accessToken: 'ci-token' },
      inMemoryStore(),
      () => NOW,
      fetchImpl,
    );

    await expect(client.get('/v1/newsletters')).rejects.toMatchObject({ status: 401 });

    // Exactly one call: the request itself, no refresh attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ci-token');
  });

  it('passes an idempotency key through as a header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: 'c1' }));
    const client = new FetchApiClient(credentials(), inMemoryStore(), () => NOW, fetchImpl);

    await client.post('/v1/campaigns/c1/send', undefined, { idempotencyKey: 'key-1' });

    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('key-1');
  });
});
