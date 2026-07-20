import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { createApp } from '../../app.js';
import { TEMPLATE_TYPES, InMemoryTemplateRepository } from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

const auth = { 'x-api-key': 'k1', 'content-type': 'application/json' };

const body = {
  name: 'Weekly digest',
  subject: 'Your {{weekOf}} digest',
  bodyHtml: '<p>Hi {{firstName}}, here is your digest.</p>',
};

function build() {
  const container: Container = buildContainer(env);
  container.rebind(TEMPLATE_TYPES.TemplateRepository).to(InMemoryTemplateRepository);
  return createApp(container);
}

describe('templates routes', () => {
  let app: ReturnType<typeof build>;

  beforeEach(() => {
    app = build();
  });

  async function create(overrides: Record<string, unknown> = {}) {
    return app.request('/v1/templates', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...body, ...overrides }),
    });
  }

  it('requires an API key', async () => {
    const res = await app.request('/v1/templates');
    expect(res.status).toBe(401);
  });

  it('creates a template (201) and returns a DTO, not the entity', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.id).toBeTruthy();
    expect(json.subject).toBe(body.subject);
    expect(json.bodyText).toBeNull();
    expect(json).toHaveProperty('createdAt');
    // No internal/VO leakage.
    expect(json).not.toHaveProperty('props');
  });

  it('rejects an invalid body (400 validation_error)', async () => {
    const res = await create({ name: '' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('validation_error');
  });

  it('rejects malformed template syntax (400 bad_request)', async () => {
    const res = await create({ bodyHtml: '<p>{{#if unterminated</p>' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('bad_request');
  });

  it('gets a template by id', async () => {
    const created = (await (await create()).json()) as { id: string };
    const res = await app.request(`/v1/templates/${created.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(created.id);
  });

  it('returns 404 for a missing template', async () => {
    const res = await app.request('/v1/templates/does-not-exist', { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('updates a template (200)', async () => {
    const created = (await (await create()).json()) as { id: string };
    const res = await app.request(`/v1/templates/${created.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('Renamed');
  });

  it('deletes a template (204), then 404 on re-delete', async () => {
    const created = (await (await create()).json()) as { id: string };
    const del = await app.request(`/v1/templates/${created.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(del.status).toBe(204);

    const again = await app.request(`/v1/templates/${created.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(again.status).toBe(404);
  });

  it('lists templates in the { data, meta: { nextCursor } } envelope', async () => {
    await create({ name: 'A' });
    await create({ name: 'B' });
    await create({ name: 'C' });

    const firstPage = await app.request('/v1/templates?limit=2', { headers: auth });
    expect(firstPage.status).toBe(200);
    const page1 = (await firstPage.json()) as {
      data: { id: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.nextCursor).toBeTruthy();

    const secondPage = await app.request(`/v1/templates?limit=2&cursor=${page1.meta.nextCursor}`, {
      headers: auth,
    });
    const page2 = (await secondPage.json()) as {
      data: { id: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.nextCursor).toBeNull();
  });

  it('serves the templates paths in the generated OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/v1/templates');
    expect(doc.paths).toHaveProperty('/v1/templates/{id}');
  });
});
