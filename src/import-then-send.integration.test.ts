import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildContainer } from './shared/di/index.js';
import { TEST_ENV, bearerHeaders } from './shared/testing/index.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  type DeliveryGateway,
} from './shared/email/index.js';
import { createApp } from './app.js';
import { NEWSLETTER_COLLECTIONS } from './newsletters/index.js';
import { SUBSCRIPTION_COLLECTIONS } from './subscriptions/index.js';
import { DELIVERABILITY_COLLECTIONS } from './deliverability/index.js';
import { TEMPLATE_COLLECTIONS } from './templates/index.js';
import { CAMPAIGN_COLLECTIONS } from './campaigns/index.js';
import { parseCsv } from './cli/presentation/csv.js';
import { toImportRow } from './cli/presentation/commands/subscriptions.js';

/**
 * The acceptance test for ADR-022, and the only place the import's real point
 * is provable: **a migrated list must not mail the people who left.**
 *
 * It runs the whole vertical against a real standalone `mongod` — the CLI's CSV
 * parser, the HTTP import endpoint, the Mongo repositories, then a campaign send
 * — because every layer in between has an opportunity to lose a status, and a
 * unit test with an in-memory repository cannot prove the stored query filter is
 * the one that runs in production.
 *
 * Only the Postmark gateway is a double; everything else is the real thing.
 */

// One row per status in the vocabulary, the shape an ESP export actually has.
const CSV = [
  'email,status,subscribedAt,confirmedAt,signupIp,firstName,tags',
  'active@dispatch.example,subscribed,2019-04-02T09:15:00Z,2019-04-02T09:20:00Z,203.0.113.1,Ada,vip',
  'waiting@dispatch.example,pending,2020-01-05T00:00:00Z,,203.0.113.2,Grace,',
  'left@dispatch.example,unsubscribed,2018-06-01T00:00:00Z,2018-06-01T00:05:00Z,203.0.113.3,Alan,',
  'dead@dispatch.example,bounced,2017-03-03T00:00:00Z,,203.0.113.4,Edsger,',
  'angry@dispatch.example,complained,2021-11-11T00:00:00Z,,203.0.113.5,Barbara,',
].join('\n');

const COLLECTIONS = [
  NEWSLETTER_COLLECTIONS.newsletters,
  SUBSCRIPTION_COLLECTIONS.subscriptions,
  DELIVERABILITY_COLLECTIONS.suppressions,
  TEMPLATE_COLLECTIONS.templates,
  CAMPAIGN_COLLECTIONS.campaigns,
  CAMPAIGN_COLLECTIONS.sends,
  CAMPAIGN_COLLECTIONS.recipientOutcomes,
];

describe('import then send (ADR-022)', () => {
  let client: MongoClient;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let gateway: InMemoryDeliveryGateway;
  let auth: Record<string, string>;

  beforeAll(async () => {
    const uri = inject('mongoUri');
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();

    const container = buildContainer({ ...TEST_ENV, DATABASE_URL: uri });
    gateway = new InMemoryDeliveryGateway();
    container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
    app = createApp(container);
    auth = await bearerHeaders();
  });

  afterEach(async () => {
    await Promise.all(COLLECTIONS.map((name) => db.collection(name).deleteMany({})));
    gateway.sent.length = 0;
  });

  afterAll(async () => {
    await client.close();
  });

  async function post(path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method: 'POST',
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function seedNewsletter(): Promise<string> {
    const res = await post('/v1/newsletters', {
      name: 'The Weekly Dispatch',
      fromName: 'Dispatch Editors',
      fromEmail: 'editors@dispatch.example',
    });
    return ((await res.json()) as { id: string }).id;
  }

  it('imports all five statuses, then sends only to the subscribed row', async () => {
    const newsletterId = await seedNewsletter();

    // Parse with the CLI's own parser, so the file → wire path under test is
    // the one an operator actually runs.
    const rows = parseCsv(CSV).map(toImportRow);
    expect(rows.every((r) => r.error === undefined)).toBe(true);

    const imported = await post(`/v1/newsletters/${newsletterId}/subscriptions/import`, {
      rows: rows.map((r) => r.row),
      source: 'mailchimp-export-2026-07',
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      received: 5,
      created: 5,
      updated: 0,
      skipped: 0,
      // The one hard bounce; the complaint must not be counted here.
      suppressed: 1,
    });

    // Importing must never mail the list — not even the `pending` row, which
    // under `Subscribe` would have triggered a double-opt-in confirmation.
    expect(gateway.sent).toHaveLength(0);

    // Every status survived the round trip through Mongo.
    const list = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions?limit=100`,
      { headers: auth },
    );
    const stored = (await list.json()) as {
      data: {
        email: string;
        status: string;
        createdAt: string;
        source: string | null;
        signupIp: string | null;
        confirmedAt: string | null;
        customFields: Record<string, unknown>;
      }[];
    };
    expect(
      Object.fromEntries(stored.data.map((s) => [s.email, s.status])),
    ).toEqual({
      'active@dispatch.example': 'subscribed',
      'waiting@dispatch.example': 'pending',
      'left@dispatch.example': 'unsubscribed',
      'dead@dispatch.example': 'bounced',
      'angry@dispatch.example': 'complained',
    });

    // The consent record and the custom-field model came across intact — and every row
    // is marked as second-hand, so an inherited consent claim never masquerades
    // as one cablegram witnessed itself.
    const active = stored.data.find((s) => s.email === 'active@dispatch.example');
    expect(active?.createdAt).toBe('2019-04-02T09:15:00.000Z');
    expect(active?.customFields).toEqual({ firstName: 'Ada' });
    expect(stored.data.every((s) => s.source === 'mailchimp-export-2026-07')).toBe(true);
    // And provenance is not a custom field — it must not be renderable.
    expect(active?.customFields).not.toHaveProperty('source');

    // The consent trail survived the round trip through Mongo, which is the
    // only way to prove the mapping actually persists it (ADR-023).
    expect(active?.signupIp).toBe('203.0.113.1');
    expect(active?.confirmedAt).toBe('2019-04-02T09:20:00.000Z');
    expect(active?.customFields).not.toHaveProperty('signupIp');
    // A row that never confirmed says so, rather than borrowing createdAt.
    expect(stored.data.find((s) => s.email === 'dead@dispatch.example')?.confirmedAt).toBeNull();

    // The imported hard bounce reached the GLOBAL list; the complaint did not
    // (ADR-018 — a mailbox fact versus a relationship fact).
    const suppressions = await app.request('/v1/suppressions?limit=100', { headers: auth });
    const listed = (await suppressions.json()) as { data: { address: string; reason: string }[] };
    expect(listed.data).toEqual([
      { address: 'dead@dispatch.example', reason: 'hard-bounce', createdAt: expect.any(String) },
    ]);

    // Now send. This is the assertion the whole issue is about.
    const template = await post('/v1/templates', {
      name: 'Shell',
      subject: 'Hello {{firstName}}',
      bodyHtml: '<p>Hi {{firstName}}</p>',
    });
    const templateId = ((await template.json()) as { id: string }).id;
    const campaign = await post('/v1/campaigns', {
      newsletterId,
      name: 'First send',
      templateId,
    });
    const campaignId = ((await campaign.json()) as { id: string }).id;

    const sent = await post(`/v1/campaigns/${campaignId}/send`);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({
      status: 'sent',
      stats: { recipients: 1, accepted: 1 },
    });

    // Exactly one recipient: the unsubscribed, bounced, complained and pending
    // rows are all excluded. Importing them as `subscribed` — what the old bulk
    // subscribe did — would have mailed four people who never asked for it.
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.recipients.map((r) => r.email)).toEqual(['active@dispatch.example']);
  });

  it('is safely re-runnable: a second pass writes nothing and never resurrects an opt-out', async () => {
    const newsletterId = await seedNewsletter();
    const rows = parseCsv(CSV).map((r) => toImportRow(r).row);
    const path = `/v1/newsletters/${newsletterId}/subscriptions/import`;

    await post(path, { rows });
    // The operator unsubscribes someone in cablegram *after* the export was
    // taken — the case `skip` exists to protect.
    const list = await app.request(`/v1/newsletters/${newsletterId}/subscriptions?limit=100`, {
      headers: auth,
    });
    const active = ((await list.json()) as { data: { id: string; email: string }[] }).data.find(
      (s) => s.email === 'active@dispatch.example',
    );
    await post(`/v1/newsletters/${newsletterId}/subscriptions/${active?.id}/unsubscribe`);

    const second = await post(path, { rows });

    expect(await second.json()).toMatchObject({ received: 5, created: 0, updated: 0, skipped: 5 });
    const after = await app.request(`/v1/newsletters/${newsletterId}/subscriptions?limit=100`, {
      headers: auth,
    });
    const stored = (await after.json()) as { data: { email: string; status: string }[] };
    expect(stored.data).toHaveLength(5);
    expect(stored.data.find((s) => s.email === 'active@dispatch.example')?.status).toBe(
      'unsubscribed',
    );
  });

  it('overwrite makes the file the truth, including bringing an opt-out back', async () => {
    const newsletterId = await seedNewsletter();
    const path = `/v1/newsletters/${newsletterId}/subscriptions/import`;
    await post(path, { rows: [{ email: 'a@dispatch.example', status: 'unsubscribed' }] });

    const res = await post(path, {
      rows: [{ email: 'a@dispatch.example', status: 'subscribed' }],
      onConflict: 'overwrite',
    });

    expect(await res.json()).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    const list = await app.request(`/v1/newsletters/${newsletterId}/subscriptions?limit=10`, {
      headers: auth,
    });
    const stored = (await list.json()) as { data: { status: string }[] };
    expect(stored.data[0]?.status).toBe('subscribed');
  });
});
