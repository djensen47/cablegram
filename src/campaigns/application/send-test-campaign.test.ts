import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  type DeliveryGateway,
} from '../../shared/email/index.js';
import { verifyUnsubscribeToken } from '../../shared/auth/index.js';
import {
  NEWSLETTER_TYPES,
  InMemoryNewsletterRepository,
  CreateNewsletter,
} from '../../newsletters/index.js';
import {
  SUBSCRIPTION_TYPES,
  InMemorySubscriptionRepository,
  ListSubscriptions,
  Subscribe,
} from '../../subscriptions/index.js';
import {
  DELIVERABILITY_TYPES,
  InMemorySuppressionRepository,
  AddSuppression,
} from '../../deliverability/index.js';
import {
  TEMPLATE_TYPES,
  InMemoryTemplateRepository,
  CreateTemplate,
} from '../../templates/index.js';
import {
  CAMPAIGN_TYPES,
  InMemoryCampaignRepository,
  InMemorySendRepository,
  InMemoryRecipientOutcomeRepository,
  InMemoryUnhandledEventRepository,
  CreateCampaign,
  GetCampaign,
  GetSend,
  ListRecipientOutcomes,
  RecordDeliveryEvents,
  SendCampaign,
  SendTestCampaign,
  CampaignContentError,
  CampaignNotFoundError,
  InvalidCampaignError,
  SendNotFoundError,
  type CampaignContentRef,
  type CampaignRecipient,
  type MessageRenderer,
  type RecipientResolver,
  type RenderedCampaignMessage,
} from '../index.js';

/**
 * The test send (ADR-025). Its value rests entirely on being the *same* send —
 * so most of what is asserted here is sameness (one renderer call, identical
 * arguments, identical headers, the same category) and absence (no send record,
 * no outcomes, no stats, no state change, no subscriber list read).
 */

const BASE_URL = 'https://api.dispatch.test';
const UNSUB_SECRET = 'a-dedicated-unsubscribe-hmac-secret';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
  POSTMARK_WEBHOOK_SECRET: 's',
  BASE_URL,
  UNSUBSCRIBE_TOKEN_SECRET: UNSUB_SECRET,
} as NodeJS.ProcessEnv;

/** Records every render call, then delegates to the real renderer. */
class RecordingRenderer implements MessageRenderer {
  readonly calls: { content: CampaignContentRef; model: Record<string, unknown> }[] = [];

  constructor(private readonly inner: MessageRenderer) {}

  async render(
    content: CampaignContentRef,
    model: Record<string, unknown>,
  ): Promise<RenderedCampaignMessage> {
    this.calls.push({ content, model });
    return this.inner.render(content, model);
  }
}

/**
 * Gate 1 must never run for a test send: the addresses given ARE the recipient
 * set. A resolver that throws turns "we didn't call it" into a failing test
 * rather than an inspection of the source.
 */
class ForbiddenRecipientResolver implements RecipientResolver {
  async resolve(): Promise<CampaignRecipient[]> {
    throw new Error('resolveRecipients must not be called by a test send');
  }
}

function testContainer(): { container: Container; gateway: InMemoryDeliveryGateway } {
  const container = buildContainer(env);
  container.rebind(CAMPAIGN_TYPES.CampaignRepository).to(InMemoryCampaignRepository);
  container.rebind(CAMPAIGN_TYPES.SendRepository).to(InMemorySendRepository);
  container
    .rebind(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    .to(InMemoryRecipientOutcomeRepository);
  container.rebind(CAMPAIGN_TYPES.UnhandledEventRepository).to(InMemoryUnhandledEventRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
  container.rebind(TEMPLATE_TYPES.TemplateRepository).to(InMemoryTemplateRepository);
  const gateway = new InMemoryDeliveryGateway();
  container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
  return { container, gateway };
}

/** Wraps whatever renderer is bound in a recorder, leaving behaviour intact. */
function recordRenders(container: Container): RecordingRenderer {
  const real = container.get<MessageRenderer>(CAMPAIGN_TYPES.MessageRenderer);
  const recorder = new RecordingRenderer(real);
  container.rebind<MessageRenderer>(CAMPAIGN_TYPES.MessageRenderer).toConstantValue(recorder);
  return recorder;
}

describe('campaigns — test send (ADR-025)', () => {
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  let newsletterId: string;
  let campaignId: string;

  beforeEach(async () => {
    ({ container, gateway } = testContainer());
    const newsletter = await container
      .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
      .execute({
        name: 'The Weekly Dispatch',
        fromName: 'Dispatch Editors',
        fromEmail: 'editors@dispatch.example',
      });
    newsletterId = newsletter.id;

    const template = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute({
        name: 'Dispatch shell',
        subject: 'This month in review',
        bodyHtml: '<h1>Hello</h1>',
      });
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'March Dispatch', templateId: template.id });
    campaignId = campaign.id;
  });

  function testSend(addresses: string[], prefixSubject = true) {
    return container
      .get<SendTestCampaign>(CAMPAIGN_TYPES.SendTestCampaign)
      .execute({ campaignId, addresses, prefixSubject });
  }

  it('delivers one broadcast to exactly the addresses given', async () => {
    const result = await testSend(['me@example.com', 'inbox@example.net']);

    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.recipients.map((r) => r.email)).toEqual([
      'me@example.com',
      'inbox@example.net',
    ]);
    expect(gateway.sent[0]?.from.fromEmail).toBe('editors@dispatch.example');
    expect(result.sent).toEqual(['me@example.com', 'inbox@example.net']);
    expect(result.bulkRequestId).toBe('in-memory-1');
  });

  it('never reads the subscriber list, even one with subscribers on it', async () => {
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
    // A resolver that throws if touched — gate 1 is not part of this path.
    container
      .rebind<RecipientResolver>(CAMPAIGN_TYPES.RecipientResolver)
      .toConstantValue(new ForbiddenRecipientResolver());
    gateway.sent.length = 0;

    await testSend(['me@example.com']);

    expect(gateway.sent[0]?.recipients.map((r) => r.email)).toEqual(['me@example.com']);
  });

  // The acceptance criterion the whole feature rests on: prove sameness by
  // capturing the renderer's arguments on both paths and comparing them.
  it('renders through the same MessageRenderer call a real send makes', async () => {
    const recorder = recordRenders(container);

    await testSend(['me@example.com']);
    await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaignId);

    expect(recorder.calls).toHaveLength(2);
    const [test, real] = recorder.calls;
    expect(test?.content).toEqual(real?.content);
    expect(test?.model).toEqual(real?.model);
    expect(test?.model).toEqual({});
  });

  it('sends the same body and category as the real send', async () => {
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
    gateway.sent.length = 0;

    await testSend(['me@example.com'], false);
    await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaignId);

    const [test, real] = gateway.sent;
    expect(test?.content).toEqual(real?.content);
    expect(test?.from).toEqual(real?.from);
    // Broadcast stream + broadcast token — the same reputation path (ADR-025 §2).
    expect(test?.category).toBe('broadcast');
    expect(real?.category).toBe('broadcast');
  });

  it('leaves no trace: no send record, no outcomes, no stats, still draft', async () => {
    await testSend(['me@example.com']);

    const after = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaignId);
    expect(after.status).toBe('draft');
    expect(after.sendId).toBeNull();
    expect(after.sentAt).toBeNull();
    expect(after.stats).toMatchObject({ recipients: 0, accepted: 0 });

    // Both read paths still say "this campaign has never been sent".
    await expect(
      container.get<GetSend>(CAMPAIGN_TYPES.GetSend).execute(campaignId),
    ).rejects.toBeInstanceOf(SendNotFoundError);
    await expect(
      container
        .get<ListRecipientOutcomes>(CAMPAIGN_TYPES.ListRecipientOutcomes)
        .execute({ campaignId, limit: 100 }),
    ).rejects.toBeInstanceOf(SendNotFoundError);
  });

  it('is repeatable — twenty proofs still leave a draft campaign', async () => {
    for (let i = 0; i < 20; i += 1) {
      await testSend(['me@example.com']);
    }

    expect(gateway.sent).toHaveLength(20);
    const after = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaignId);
    expect(after.status).toBe('draft');
  });

  it('prefixes the subject by default, and leaves it byte-identical on request', async () => {
    const prefixed = await testSend(['me@example.com']);
    expect(prefixed.subject).toBe('[TEST] This month in review');
    expect(gateway.sent[0]?.content.subject).toBe('[TEST] This month in review');

    const bare = await testSend(['me@example.com'], false);
    expect(bare.subject).toBe('This month in review');
    expect(gateway.sent[1]?.content.subject).toBe('This month in review');
  });

  it('applies the global suppression list and reports what it dropped', async () => {
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'dead@example.com', reason: 'hard-bounce' });

    const result = await testSend(['me@example.com', 'Dead@Example.com']);

    expect(result.sent).toEqual(['me@example.com']);
    expect(result.suppressed).toEqual(['dead@example.com']);
    expect(gateway.sent[0]?.recipients.map((r) => r.email)).toEqual(['me@example.com']);
  });

  it('calls the provider not at all when every address is suppressed', async () => {
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'dead@example.com', reason: 'hard-bounce' });

    const result = await testSend(['dead@example.com']);

    expect(gateway.sent).toHaveLength(0);
    expect(result.sent).toEqual([]);
    expect(result.bulkRequestId).toBeNull();
    // The subject is still reported — the render happened, which is most of
    // what the operator wanted to know.
    expect(result.subject).toBe('[TEST] This month in review');
  });

  it('carries a verifiable List-Unsubscribe header bound to a synthetic subscription', async () => {
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'me@example.com', doubleOptIn: false });
    gateway.sent.length = 0;

    await testSend(['me@example.com']);

    const recipient = gateway.sent[0]!.recipients[0]!;
    const headers = Object.fromEntries((recipient.headers ?? []).map((h) => [h.name, h.value]));
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    const url = new URL(headers['List-Unsubscribe']!.slice(1, -1));
    expect(url.origin + url.pathname).toBe(`${BASE_URL}/v1/unsubscribe`);
    const subscriptionId = url.searchParams.get('subscriptionId')!;
    const token = url.searchParams.get('token')!;
    // The token verifies — so a mail client renders the affordance…
    expect(verifyUnsubscribeToken(UNSUB_SECRET, newsletterId, subscriptionId, token)).toBe(true);

    // …but it is bound to a synthetic id, so the one-click POST is a quiet
    // no-op and the operator's real membership survives being proof-mailed.
    const rows = await container
      .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
      .execute({ newsletterId, limit: 50 });
    expect(rows.map((r) => r.id)).not.toContain(subscriptionId);
    expect(rows[0]?.status).toBe('subscribed');
  });

  it('tags the provider message so its events can never reach the campaign', async () => {
    // Send for real first, so the campaign HAS outcomes a stray event could
    // corrupt — the dangerous case, not the trivially safe draft one.
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
    await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaignId);
    await testSend(['reader@dispatch.example']);

    const tag = gateway.sent[gateway.sent.length - 1]?.tag;
    expect(tag).toBe(`test:${campaignId}`);
    expect(tag).not.toBe(campaignId);

    // A bounce on the proof does not touch the real send's outcomes.
    await container.get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents).execute({
      RecordType: 'Bounce',
      Type: 'HardBounce',
      Email: 'reader@dispatch.example',
      MessageID: 'proof-1',
      BouncedAt: '2026-07-27T10:00:00Z',
      Tag: tag,
    });

    const outcomes = await container
      .get<ListRecipientOutcomes>(CAMPAIGN_TYPES.ListRecipientOutcomes)
      .execute({ campaignId, limit: 100 });
    expect(outcomes.map((o) => o.status)).toEqual(['accepted']);
  });

  it('is legal on an already-sent campaign, and changes nothing about it', async () => {
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
    const sent = await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaignId);
    const sendId = sent.sendId;

    await testSend(['me@example.com']);

    const after = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaignId);
    expect(after.status).toBe('sent');
    expect(after.sendId).toBe(sendId);
    expect(after.stats).toMatchObject({ recipients: 1, accepted: 1 });
  });

  it('fails on unrenderable content exactly as a real send does', async () => {
    const broken = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'Bad ref', templateId: 'no-such-template' });

    await expect(
      container
        .get<SendTestCampaign>(CAMPAIGN_TYPES.SendTestCampaign)
        .execute({ campaignId: broken.id, addresses: ['me@example.com'], prefixSubject: true }),
    ).rejects.toBeInstanceOf(CampaignContentError);
    expect(gateway.sent).toHaveLength(0);
  });

  it('rejects an unknown campaign', async () => {
    await expect(
      container
        .get<SendTestCampaign>(CAMPAIGN_TYPES.SendTestCampaign)
        .execute({ campaignId: 'missing', addresses: ['me@example.com'], prefixSubject: true }),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  it('caps the target list, counting duplicates only once', async () => {
    await expect(
      testSend(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com']),
    ).rejects.toBeInstanceOf(InvalidCampaignError);

    // Six entries, five distinct addresses — a duplicate cannot pad the cap,
    // and the repeat is mailed once.
    const result = await testSend([
      'a@x.com',
      'A@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
      'e@x.com',
    ]);
    expect(result.sent).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  });

  it('rejects an empty target list', async () => {
    await expect(testSend([])).rejects.toBeInstanceOf(InvalidCampaignError);
    expect(gateway.sent).toHaveLength(0);
  });
});
