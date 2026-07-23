import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV, bearerHeaders } from '../../shared/testing/index.js';
import { createApp } from '../../app.js';
import { NEWSLETTER_TYPES, InMemoryNewsletterRepository } from '../index.js';

const body = {
  name: 'The Weekly Dispatch',
  fromName: 'Dispatch Editors',
  fromEmail: 'editors@dispatch.example',
};

function build() {
  const container: Container = buildContainer(TEST_ENV);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  return createApp(container);
}

describe('newsletters routes', () => {
  let app: ReturnType<typeof build>;
  let auth: Record<string, string>;

  beforeEach(async () => {
    app = build();
    auth = await bearerHeaders();
  });

  async function create(overrides: Record<string, unknown> = {}) {
    const res = await app.request('/v1/newsletters', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...body, ...overrides }),
    });
    return res;
  }

  it('requires a JWT', async () => {
    const res = await app.request('/v1/newsletters');
    expect(res.status).toBe(401);
  });

  it('creates a newsletter (201) and returns a DTO, not the entity', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.id).toBeTruthy();
    expect(json.fromEmail).toBe('editors@dispatch.example');
    expect(json.replyTo).toBeNull();
    expect(json).toHaveProperty('createdAt');
    // No internal/VO leakage.
    expect(json).not.toHaveProperty('props');
  });

  it('rejects an invalid body (400 validation_error)', async () => {
    const res = await create({ fromEmail: 'nope' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('validation_error');
  });

  it('gets a newsletter by id', async () => {
    const created = (await (await create()).json()) as { id: string };
    const res = await app.request(`/v1/newsletters/${created.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(created.id);
  });

  it('returns 404 for a missing newsletter', async () => {
    const res = await app.request('/v1/newsletters/does-not-exist', { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('updates a newsletter (200)', async () => {
    const created = (await (await create()).json()) as { id: string };
    const res = await app.request(`/v1/newsletters/${created.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('Renamed');
  });

  it('deletes a newsletter (204), then 404 on re-delete', async () => {
    const created = (await (await create()).json()) as { id: string };
    const del = await app.request(`/v1/newsletters/${created.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(del.status).toBe(204);

    const again = await app.request(`/v1/newsletters/${created.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(again.status).toBe(404);
  });

  it('lists newsletters in the { data, meta: { nextCursor } } envelope', async () => {
    await create({ name: 'A' });
    await create({ name: 'B' });
    await create({ name: 'C' });

    const firstPage = await app.request('/v1/newsletters?limit=2', { headers: auth });
    expect(firstPage.status).toBe(200);
    const page1 = (await firstPage.json()) as {
      data: { id: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.nextCursor).toBeTruthy();

    const secondPage = await app.request(
      `/v1/newsletters?limit=2&cursor=${page1.meta.nextCursor}`,
      { headers: auth },
    );
    const page2 = (await secondPage.json()) as {
      data: { id: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.nextCursor).toBeNull();
  });

  it('serves a generated OpenAPI document at /openapi.json (open)', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths).toHaveProperty('/v1/newsletters');
    expect(doc.paths).toHaveProperty('/v1/newsletters/{id}');
    expect(doc.components?.securitySchemes).toHaveProperty('BearerAuth');
  });
});
