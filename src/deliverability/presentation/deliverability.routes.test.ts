import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV, bearerHeaders } from '../../shared/testing/index.js';
import { createApp } from '../../app.js';
import { DELIVERABILITY_TYPES, InMemorySuppressionRepository } from '../index.js';

function build() {
  const container: Container = buildContainer(TEST_ENV);
  container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
  return createApp(container);
}

describe('deliverability routes', () => {
  let app: ReturnType<typeof build>;
  let auth: Record<string, string>;

  beforeEach(async () => {
    app = build();
    auth = await bearerHeaders();
  });

  async function add(overrides: Record<string, unknown> = {}) {
    return app.request('/v1/suppressions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ address: 'bounced@dispatch.example', reason: 'hard-bounce', ...overrides }),
    });
  }

  it('requires a JWT', async () => {
    const res = await app.request('/v1/suppressions');
    expect(res.status).toBe(401);
  });

  it('adds a suppression (201) and returns a DTO', async () => {
    const res = await add();
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.address).toBe('bounced@dispatch.example');
    expect(json.reason).toBe('hard-bounce');
    expect(json).toHaveProperty('createdAt');
  });

  it('rejects an unknown reason (400 validation_error)', async () => {
    const res = await add({ reason: 'because-i-said-so' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('validation_error');
  });

  it('rejects an invalid address (400 validation_error)', async () => {
    const res = await add({ address: 'nope' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('validation_error');
  });

  it('is idempotent over the wire: re-adding returns the original entry', async () => {
    const first = (await (await add()).json()) as { createdAt: string };
    const res = await add({ address: 'BOUNCED@dispatch.example', reason: 'spam-complaint' });
    expect(res.status).toBe(201);
    const second = (await res.json()) as { reason: string; createdAt: string };
    expect(second.reason).toBe('hard-bounce');
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('checks a suppressed address (200)', async () => {
    await add();
    const res = await app.request('/v1/suppressions/bounced@dispatch.example', { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { address: string }).address).toBe('bounced@dispatch.example');
  });

  it('returns 404 checking a non-suppressed address', async () => {
    const res = await app.request('/v1/suppressions/clean@dispatch.example', { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('removes a suppression (204), then 404 on re-remove', async () => {
    await add();
    const del = await app.request('/v1/suppressions/bounced@dispatch.example', {
      method: 'DELETE',
      headers: auth,
    });
    expect(del.status).toBe(204);

    const again = await app.request('/v1/suppressions/bounced@dispatch.example', {
      method: 'DELETE',
      headers: auth,
    });
    expect(again.status).toBe(404);
  });

  it('lists suppressions in the { data, meta: { nextCursor } } envelope', async () => {
    await add({ address: 'a@dispatch.example' });
    await add({ address: 'b@dispatch.example' });
    await add({ address: 'c@dispatch.example' });

    const firstPage = await app.request('/v1/suppressions?limit=2', { headers: auth });
    expect(firstPage.status).toBe(200);
    const page1 = (await firstPage.json()) as {
      data: { address: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.nextCursor).toBeTruthy();

    const secondPage = await app.request(
      `/v1/suppressions?limit=2&cursor=${page1.meta.nextCursor}`,
      { headers: auth },
    );
    const page2 = (await secondPage.json()) as {
      data: { address: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.nextCursor).toBeNull();
  });

  it('serves the suppressions paths in the generated OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/v1/suppressions');
    expect(doc.paths).toHaveProperty('/v1/suppressions/{address}');
  });
});
