import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { TYPES, buildContainer } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  type DeliveryGateway,
} from '../../shared/email/index.js';
import {
  NEWSLETTER_TYPES,
  InMemoryNewsletterRepository,
  CreateNewsletter,
} from '../../newsletters/index.js';
import {
  SUBSCRIPTION_TYPES,
  InMemorySubscriptionRepository,
  Subscribe,
} from '../../subscriptions/index.js';
import {
  DELIVERABILITY_TYPES,
  InMemorySuppressionRepository,
  AddSuppression,
  FilterSuppressed,
} from '../../deliverability/index.js';
import { TEMPLATE_TYPES, InMemoryTemplateRepository, CreateTemplate } from '../../templates/index.js';
import {
  CAMPAIGN_TYPES,
  InMemoryCampaignRepository,
  InMemorySendRecordRepository,
  CreateCampaign,
  GetCampaign,
  UpdateCampaign,
  SendCampaign,
  GetSendRecord,
  RecordDeliveryEvents,
  DispatchDueCampaigns,
  CampaignNotFoundError,
  CampaignStateError,
  CampaignContentError,
} from '../index.js';

/** A `Clock` test double whose `now()` can be advanced deterministically —
 * scheduling tests need explicit control over "before"/"after due" instants
 * that the real `DefaultClock` can't offer. */
class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advanceTo(date: Date): void {
    this.current = date;
  }
}

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

// Rebind campaigns' own repositories, the four upstream contexts' repositories,
// and the email gateway to their in-memory doubles (ADR-003). The cross-context
// facade adapters stay on real wiring, so the send runs end-to-end with no DB.
function testContainer(): { container: Container; gateway: InMemoryDeliveryGateway } {
  const container = buildContainer(env);
  container.rebind(CAMPAIGN_TYPES.CampaignRepository).to(InMemoryCampaignRepository);
  container.rebind(CAMPAIGN_TYPES.SendRecordRepository).to(InMemorySendRecordRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
  container.rebind(TEMPLATE_TYPES.TemplateRepository).to(InMemoryTemplateRepository);
  const gateway = new InMemoryDeliveryGateway();
  container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
  return { container, gateway };
}

async function seedNewsletter(container: Container): Promise<string> {
  const newsletter = await container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).execute({
    name: 'The Weekly Dispatch',
    fromName: 'Dispatch Editors',
    fromEmail: 'editors@dispatch.example',
  });
  return newsletter.id;
}

async function subscribe(
  container: Container,
  newsletterId: string,
  email: string,
  opts: { doubleOptIn?: boolean; tags?: string[] } = {},
): Promise<void> {
  await container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe).execute({
    newsletterId,
    email,
    doubleOptIn: opts.doubleOptIn ?? false,
    tags: opts.tags,
  });
}

async function seedTemplate(container: Container): Promise<string> {
  const template = await container.get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate).execute({
    name: 'Dispatch shell',
    subject: 'This month in review',
    bodyHtml: '<h1>Hello {{firstName}}</h1>',
  });
  return template.id;
}

describe('campaigns — the send integrator', () => {
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  let newsletterId: string;

  beforeEach(async () => {
    ({ container, gateway } = testContainer());
    newsletterId = await seedNewsletter(container);
  });

  async function seedTwoGatedAudience(): Promise<void> {
    // Gate 1 passers (subscribed):
    await subscribe(container, newsletterId, 'keep1@dispatch.example');
    await subscribe(container, newsletterId, 'keep2@dispatch.example');
    // Subscribed but suppressed — dropped by gate 2:
    await subscribe(container, newsletterId, 'suppressed@dispatch.example');
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'suppressed@dispatch.example', reason: 'manual-junk' });
    // Pending (double opt-in) — dropped by gate 1:
    await subscribe(container, newsletterId, 'pending@dispatch.example', { doubleOptIn: true });
  }

  it('sends to exactly the two-gated recipients in one provider call', async () => {
    await seedTwoGatedAudience();
    const templateId = await seedTemplate(container);
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'March Dispatch', templateId });

    // Ignore the double-opt-in confirmation email the pending seed sent through
    // the same gateway — assert only the campaign broadcast below.
    gateway.sent.length = 0;
    const sent = await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id);

    expect(gateway.sent).toHaveLength(1);
    const recipients = gateway.sent[0]?.recipients.map((r) => r.email).sort();
    expect(recipients).toEqual(['keep1@dispatch.example', 'keep2@dispatch.example']);
    expect(gateway.sent[0]?.from.fromEmail).toBe('editors@dispatch.example');
    expect(gateway.sent[0]?.tag).toBe(campaign.id);
    expect(gateway.sent[0]?.content.subject).toBe('This month in review');

    expect(sent.status).toBe('sent');
    expect(sent.stats).toMatchObject({ recipients: 2, accepted: 2, rejected: 0 });
    expect(sent.sendId).not.toBeNull();
    expect(sent.sentAt).not.toBeNull();
  });

  it('renders inline content when there is no template reference', async () => {
    await subscribe(container, newsletterId, 'keep1@dispatch.example');
    const campaign = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
      newsletterId,
      name: 'Inline',
      subject: 'Inline subject',
      bodyHtml: '<p>Inline body</p>',
    });

    await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id);

    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.content.subject).toBe('Inline subject');
    expect(gateway.sent[0]?.content.htmlBody).toBe('<p>Inline body</p>');
  });

  it('honours a query-time tag segment (AND over tags)', async () => {
    await subscribe(container, newsletterId, 'vip@dispatch.example', { tags: ['vip', 'beta'] });
    await subscribe(container, newsletterId, 'plain@dispatch.example', { tags: ['beta'] });
    const templateId = await seedTemplate(container);
    const campaign = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
      newsletterId,
      name: 'VIPs only',
      templateId,
      segmentTags: ['vip'],
    });

    await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id);

    expect(gateway.sent[0]?.recipients.map((r) => r.email)).toEqual(['vip@dispatch.example']);
  });

  it('re-sending a sent campaign is a no-op', async () => {
    await subscribe(container, newsletterId, 'keep1@dispatch.example');
    const templateId = await seedTemplate(container);
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'Once', templateId });

    const send = container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign);
    await send.execute(campaign.id);
    const again = await send.execute(campaign.id);

    expect(gateway.sent).toHaveLength(1); // no second broadcast
    expect(again.status).toBe('sent');
  });

  it('sends to nobody without calling the provider when both gates empty the set', async () => {
    // Only a pending subscriber — gate 1 drops it; nothing left to send.
    await subscribe(container, newsletterId, 'pending@dispatch.example', { doubleOptIn: true });
    const templateId = await seedTemplate(container);
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'Empty', templateId });

    // Drop the pending seed's confirmation email; assert the send made no call.
    gateway.sent.length = 0;
    const sent = await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id);

    expect(gateway.sent).toHaveLength(0);
    expect(sent.status).toBe('sent');
    expect(sent.stats.recipients).toBe(0);
  });

  it('rejects sending an unknown campaign', async () => {
    await expect(
      container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute('missing'),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  it('fails the send when the template reference cannot be resolved', async () => {
    await subscribe(container, newsletterId, 'keep1@dispatch.example');
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'Bad ref', templateId: 'no-such-template' });

    await expect(
      container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id),
    ).rejects.toBeInstanceOf(CampaignContentError);

    // The campaign stays editable (never marked sending) because rendering runs
    // before the state transition.
    const after = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaign.id);
    expect(after.status).toBe('draft');
    expect(gateway.sent).toHaveLength(0);
  });

  it('refuses to edit a sent campaign', async () => {
    await subscribe(container, newsletterId, 'keep1@dispatch.example');
    const templateId = await seedTemplate(container);
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId, name: 'Locked', templateId });
    await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id);

    const fresh = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaign.id);
    expect(() => fresh.update({ name: 'renamed' }, new Date())).toThrow(CampaignStateError);
  });

  describe('webhook reconciliation', () => {
    async function sendToTwo(): Promise<string> {
      await subscribe(container, newsletterId, 'keep1@dispatch.example');
      await subscribe(container, newsletterId, 'keep2@dispatch.example');
      const templateId = await seedTemplate(container);
      const campaign = await container
        .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
        .execute({ newsletterId, name: 'March', templateId });
      await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(campaign.id);
      return campaign.id;
    }

    function fixtures(campaignId: string): unknown[] {
      return [
        {
          RecordType: 'Delivery',
          Recipient: 'keep1@dispatch.example',
          MessageID: 'in-memory-1-0',
          DeliveredAt: '2026-07-20T10:00:00Z',
          Tag: campaignId,
        },
        {
          RecordType: 'Bounce',
          Type: 'HardBounce',
          Email: 'keep2@dispatch.example',
          MessageID: 'in-memory-1-1',
          BouncedAt: '2026-07-20T10:01:00Z',
          Tag: campaignId,
        },
      ];
    }

    it('applies delivery + hard-bounce events to the send record and pushes a suppression', async () => {
      const campaignId = await sendToTwo();

      await container
        .get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents)
        .execute(fixtures(campaignId));

      const record = await container
        .get<GetSendRecord>(CAMPAIGN_TYPES.GetSendRecord)
        .execute(campaignId);
      const byAddress = Object.fromEntries(record.outcomes.map((o) => [o.address, o.status]));
      expect(byAddress['keep1@dispatch.example']).toBe('delivered');
      expect(byAddress['keep2@dispatch.example']).toBe('bounced');

      // The hard bounce was added to cablegram's own suppression list.
      const stillSuppressed = await container
        .get<FilterSuppressed>(DELIVERABILITY_TYPES.FilterSuppressed)
        .execute(['keep2@dispatch.example']);
      expect(stillSuppressed).toEqual(['keep2@dispatch.example']);

      // The campaign's aggregate stats reflect the record.
      const campaign = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaignId);
      expect(campaign.stats).toMatchObject({ recipients: 2, delivered: 1, bounced: 1 });
    });

    it('is idempotent under duplicate / out-of-order delivery', async () => {
      const campaignId = await sendToTwo();
      const record = container.get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents);
      const payload = fixtures(campaignId);

      await record.execute(payload);
      await record.execute(payload); // duplicate delivery

      const after = await container.get<GetSendRecord>(CAMPAIGN_TYPES.GetSendRecord).execute(campaignId);
      const bounced = after.outcomes.filter((o) => o.status === 'bounced');
      expect(bounced).toHaveLength(1);

      const campaign = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaignId);
      expect(campaign.stats).toMatchObject({ delivered: 1, bounced: 1, complained: 0 });
    });

    it('excludes a newly-suppressed address from a subsequent send', async () => {
      const campaignId = await sendToTwo();
      await container
        .get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents)
        .execute(fixtures(campaignId));

      // A second campaign to the same audience must skip the bounced address.
      const templateId = await seedTemplate(container);
      const next = await container
        .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
        .execute({ newsletterId, name: 'April', templateId });
      await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(next.id);

      const secondSend = gateway.sent[1];
      expect(secondSend?.recipients.map((r) => r.email)).toEqual(['keep1@dispatch.example']);
    });

    it('tolerates events for an unknown campaign tag', async () => {
      await expect(
        container.get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents).execute({
          RecordType: 'Delivery',
          Recipient: 'someone@dispatch.example',
          MessageID: 'x',
          Tag: 'no-such-campaign',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('scheduling (ADR-009\'s open item) — dispatch-due', () => {
    let clock: MutableClock;
    let t0: Date;

    beforeEach(() => {
      t0 = new Date('2026-07-20T12:00:00Z');
      clock = new MutableClock(t0);
      container.rebind<Clock>(TYPES.Clock).toConstantValue(clock);
    });

    function inFuture(ms: number): Date {
      return new Date(t0.getTime() + ms);
    }

    it('starts a campaign `scheduled` when created with a future scheduledAt', async () => {
      const templateId = await seedTemplate(container);
      const campaign = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
        newsletterId,
        name: 'March',
        templateId,
        scheduledAt: inFuture(60_000),
      });

      expect(campaign.status).toBe('scheduled');
      expect(campaign.scheduledAt).toEqual(inFuture(60_000));
    });

    it('rejects a scheduledAt that is not in the future', async () => {
      const templateId = await seedTemplate(container);
      await expect(
        container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
          newsletterId,
          name: 'March',
          templateId,
          scheduledAt: t0,
        }),
      ).rejects.toThrow(/must be a future time/);
    });

    it('unschedules back to draft when scheduledAt is cleared, and reschedules on update', async () => {
      const templateId = await seedTemplate(container);
      const campaign = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
        newsletterId,
        name: 'March',
        templateId,
        scheduledAt: inFuture(60_000),
      });

      const unscheduled = await container
        .get<UpdateCampaign>(CAMPAIGN_TYPES.UpdateCampaign)
        .execute(campaign.id, { scheduledAt: null });
      expect(unscheduled.status).toBe('draft');
      expect(unscheduled.scheduledAt).toBeNull();

      const rescheduled = await container
        .get<UpdateCampaign>(CAMPAIGN_TYPES.UpdateCampaign)
        .execute(campaign.id, { scheduledAt: inFuture(120_000) });
      expect(rescheduled.status).toBe('scheduled');
      expect(rescheduled.scheduledAt).toEqual(inFuture(120_000));
    });

    it('dispatch-due sends a due campaign and leaves a not-yet-due one untouched', async () => {
      await subscribe(container, newsletterId, 'reader@dispatch.example');
      const templateId = await seedTemplate(container);
      const due = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
        newsletterId,
        name: 'Due',
        templateId,
        scheduledAt: inFuture(1_000),
      });
      const notYetDue = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
        newsletterId,
        name: 'Later',
        templateId,
        scheduledAt: inFuture(10_000),
      });

      clock.advanceTo(inFuture(2_000)); // past `due`, still before `notYetDue`
      gateway.sent.length = 0;
      const results = await container
        .get<DispatchDueCampaigns>(CAMPAIGN_TYPES.DispatchDueCampaigns)
        .execute();

      expect(results).toEqual([{ campaignId: due.id, status: 'sent' }]);
      expect(gateway.sent).toHaveLength(1);

      const stillScheduled = await container
        .get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign)
        .execute(notYetDue.id);
      expect(stillScheduled.status).toBe('scheduled');
    });

    it('respects the batch limit, leaving the rest due for a later call', async () => {
      const templateId = await seedTemplate(container);
      const createCampaign = container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const c = await createCampaign.execute({
          newsletterId,
          name: `Batch ${i}`,
          templateId,
          scheduledAt: inFuture(1_000),
        });
        ids.push(c.id);
      }
      clock.advanceTo(inFuture(2_000));

      const first = await container
        .get<DispatchDueCampaigns>(CAMPAIGN_TYPES.DispatchDueCampaigns)
        .execute({ limit: 2 });
      expect(first).toHaveLength(2);

      const second = await container
        .get<DispatchDueCampaigns>(CAMPAIGN_TYPES.DispatchDueCampaigns)
        .execute({ limit: 2 });
      expect(second).toHaveLength(1);
    });

    it('force-fails a due campaign that never starts sending, instead of retrying it forever', async () => {
      await subscribe(container, newsletterId, 'reader@dispatch.example');
      const campaign = await container.get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).execute({
        newsletterId,
        name: 'Poison pill',
        templateId: 'no-such-template',
        scheduledAt: inFuture(1_000),
      });
      clock.advanceTo(inFuture(2_000));

      const results = await container
        .get<DispatchDueCampaigns>(CAMPAIGN_TYPES.DispatchDueCampaigns)
        .execute();
      expect(results).toEqual([{ campaignId: campaign.id, status: 'failed' }]);

      const after = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaign.id);
      expect(after.status).toBe('failed');

      // A second sweep must not pick it up again (it's no longer `scheduled`).
      const again = await container
        .get<DispatchDueCampaigns>(CAMPAIGN_TYPES.DispatchDueCampaigns)
        .execute();
      expect(again).toEqual([]);
    });
  });
});
