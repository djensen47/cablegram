import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer, TYPES as SHARED_TYPES } from '../../shared/di/index.js';
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
import { DELIVERABILITY_TYPES, InMemorySuppressionRepository } from '../../deliverability/index.js';
import { TEMPLATE_TYPES, InMemoryTemplateRepository, CreateTemplate } from '../../templates/index.js';
import {
  CAMPAIGN_TYPES,
  InMemoryCampaignRepository,
  InMemorySendRepository,
  InMemoryRecipientOutcomeRepository,
  InMemoryUnhandledEventRepository,
  CreateCampaign,
  GetCampaign,
  GetSend,
  RecordDeliveryEvents,
  SendCampaign,
  ResolveSend,
  NOT_SENT_WAIT_MS,
  UpdateCampaign,
  CampaignNotFoundError,
  CampaignSendOutcomeUnknownError,
  CampaignSendRejectedError,
  CampaignSendUnresolvedError,
  CampaignStateError,
  type Campaign,
  type CampaignStatus,
  type RecipientOutcome,
  type Send,
} from '../index.js';

/**
 * What a second `POST /send` does after the first one went wrong (ADR-035).
 *
 * The one thing every test here protects is the count on the right-hand side of
 * `gateway.sent`: the provider must never hold the same campaign twice. Each
 * test breaks the send at a different point and then calls it again, because
 * calling it again is exactly what an operator does when a send errors.
 */

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  BASE_URL: 'https://cablegram.test',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  SYSTEM_EMAIL_CHANNEL: 'outbound',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

const AUDIENCE = ['a@dispatch.example', 'b@dispatch.example', 'c@dispatch.example'];

/** Real time, plus whatever a test has let pass. */
class TestClock implements Clock {
  private ahead = 0;
  now(): Date {
    return new Date(Date.now() + this.ahead);
  }
  advance(ms: number): void {
    this.ahead += ms;
  }
}

/** A store hiccup: the write it is thrown from fails once, then works. */
class StoreDown extends Error {
  constructor() {
    super('mongo: connection reset');
  }
}

class FlakyCampaignRepository extends InMemoryCampaignRepository {
  /** Fail the next write that would store this status. */
  failNextWriteOf: CampaignStatus | null = null;

  override async saveIfStatus(campaign: Campaign, from: readonly CampaignStatus[]): Promise<boolean> {
    if (this.failNextWriteOf === campaign.status) {
      this.failNextWriteOf = null;
      throw new StoreDown();
    }
    return super.saveIfStatus(campaign, from);
  }
}

class FlakySendRepository extends InMemorySendRepository {
  failNextCreate = false;
  failNextUpdate = false;
  created = 0;

  override async create(send: Send): Promise<void> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new StoreDown();
    }
    this.created += 1;
    return super.create(send);
  }

  override async update(send: Send): Promise<void> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new StoreDown();
    }
    return super.update(send);
  }
}

class FlakyOutcomeRepository extends InMemoryRecipientOutcomeRepository {
  failNextMarkAccepted = false;
  rowsCreated = 0;

  override async createMany(outcomes: readonly RecipientOutcome[]): Promise<void> {
    this.rowsCreated += outcomes.length;
    return super.createMany(outcomes);
  }

  override async markAccepted(sendId: string, now: Date): Promise<void> {
    if (this.failNextMarkAccepted) {
      this.failNextMarkAccepted = false;
      throw new StoreDown();
    }
    return super.markAccepted(sendId, now);
  }
}

describe('sending a campaign again after a failure (ADR-035)', () => {
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  let campaigns: FlakyCampaignRepository;
  let sends: FlakySendRepository;
  let outcomes: FlakyOutcomeRepository;
  let clock: TestClock;
  let campaignId: string;
  let send: SendCampaign;

  beforeEach(async () => {
    container = buildContainer(env);
    clock = new TestClock();
    container.rebind<Clock>(SHARED_TYPES.Clock).toConstantValue(clock);
    campaigns = new FlakyCampaignRepository();
    sends = new FlakySendRepository();
    outcomes = new FlakyOutcomeRepository();
    gateway = new InMemoryDeliveryGateway();
    container.rebind(CAMPAIGN_TYPES.CampaignRepository).toConstantValue(campaigns);
    container.rebind(CAMPAIGN_TYPES.SendRepository).toConstantValue(sends);
    container.rebind(CAMPAIGN_TYPES.RecipientOutcomeRepository).toConstantValue(outcomes);
    container
      .rebind(CAMPAIGN_TYPES.UnhandledEventRepository)
      .to(InMemoryUnhandledEventRepository);
    container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
    container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
    container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
    container.rebind(TEMPLATE_TYPES.TemplateRepository).to(InMemoryTemplateRepository);
    container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);

    const newsletter = await container
      .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
      .execute({
        name: 'The Weekly Dispatch',
        fromName: 'Dispatch Editors',
        fromEmail: 'editors@dispatch.example',
        campaignChannel: 'weekly-dispatch',
        confirmationChannel: 'weekly-confirmations',
      });
    for (const email of AUDIENCE) {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId: newsletter.id, email, doubleOptIn: false });
    }
    const template = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute({ name: 'Shell', subject: 'This month', bodyHtml: '<h1>Hello</h1>' });
    const campaign = await container
      .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
      .execute({ newsletterId: newsletter.id, name: 'The big one', templateId: template.id });
    campaignId = campaign.id;
    send = container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign);
  });

  const status = async (): Promise<CampaignStatus> =>
    (await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(campaignId)).status;

  describe('the provider refused the submission', () => {
    it('fails the campaign, and sending again submits it once', async () => {
      gateway.refuseNext();

      const refusal = await send.execute(campaignId).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(CampaignSendRejectedError);
      // The provider's own answer survives to the caller: it says what to fix.
      expect((refusal as Error).message).toContain('no such stream');
      expect(await status()).toBe('failed');
      expect(gateway.sent).toHaveLength(0);

      const retried = await send.execute(campaignId);

      expect(retried.status).toBe('sent');
      expect(retried.recipientCount).toBe(AUDIENCE.length);
      expect(gateway.sent).toHaveLength(1);
    });
  });

  describe('the provider took the submission and the answer was lost', () => {
    it('leaves the campaign `sending` — not `failed` — and never submits it again', async () => {
      gateway.loseNextAnswer();

      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(CampaignSendOutcomeUnknownError);
      expect(await status()).toBe('sending');
      expect(gateway.sent).toHaveLength(1);

      // The operator runs it again. And again.
      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(CampaignSendUnresolvedError);
      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(CampaignSendUnresolvedError);

      expect(gateway.calls).toBe(1);
      expect(gateway.sent).toHaveLength(1);
      expect(await status()).toBe('sending');
    });

    it('a refused repeat writes nothing — no second send record, no second set of rows', async () => {
      gateway.loseNextAnswer();
      await send.execute(campaignId).catch(() => undefined);
      expect(sends.created).toBe(1);
      expect(outcomes.rowsCreated).toBe(AUDIENCE.length);

      await send.execute(campaignId).catch(() => undefined);

      expect(sends.created).toBe(1);
      expect(outcomes.rowsCreated).toBe(AUDIENCE.length);
    });

    it('still records delivery events for it, so the evidence builds up', async () => {
      gateway.loseNextAnswer();
      await send.execute(campaignId).catch(() => undefined);
      const getSend = container.get<GetSend>(CAMPAIGN_TYPES.GetSend);

      // No acknowledgment was stored, so nobody is `accepted` yet.
      expect((await getSend.execute(campaignId)).stats).toMatchObject({
        recipients: AUDIENCE.length,
        accepted: 0,
      });

      // The provider did take it, so its webhooks arrive — and land.
      await container.get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents).execute({
        RecordType: 'Delivery',
        Recipient: AUDIENCE[0],
        MessageID: 'm-1',
        DeliveredAt: '2026-07-20T10:00:00Z',
        Tag: campaignId,
      });

      expect((await getSend.execute(campaignId)).stats).toMatchObject({ accepted: 1, delivered: 1 });
    });
  });

  describe('the provider accepted, and a write after that failed', () => {
    it('does not fail the campaign when raising the recipients fails; a repeat finishes without resubmitting', async () => {
      outcomes.failNextMarkAccepted = true;

      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(StoreDown);
      expect(await status()).toBe('sending');

      const retried = await send.execute(campaignId);

      expect(retried.status).toBe('sent');
      expect(retried.recipientCount).toBe(AUDIENCE.length);
      expect(gateway.calls).toBe(1);
      const { send: record, stats } = await container
        .get<GetSend>(CAMPAIGN_TYPES.GetSend)
        .execute(campaignId);
      expect(record.bulkRequestId).toBe('in-memory-1');
      expect(stats.accepted).toBe(AUDIENCE.length);
    });

    it('does not fail the campaign when marking it sent fails; a repeat finishes without resubmitting', async () => {
      campaigns.failNextWriteOf = 'sent';

      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(StoreDown);
      expect(await status()).toBe('sending');

      const retried = await send.execute(campaignId);

      expect(retried.status).toBe('sent');
      expect(retried.sentAt).not.toBeNull();
      expect(gateway.calls).toBe(1);
    });

    it('stays `sending` and is not resubmitted when the acknowledgment itself could not be stored', async () => {
      sends.failNextUpdate = true;

      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(StoreDown);
      expect(await status()).toBe('sending');

      // With no stored acknowledgment there is no proof, so the repeat is
      // refused rather than guessed at.
      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(CampaignSendUnresolvedError);
      expect(gateway.calls).toBe(1);
    });
  });

  describe('nothing was submitted', () => {
    it('gives the claim back when the send record cannot be opened', async () => {
      sends.failNextCreate = true;

      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(StoreDown);
      expect(await status()).toBe('failed');
      expect(gateway.calls).toBe(0);

      const retried = await send.execute(campaignId);
      expect(retried.status).toBe('sent');
      expect(gateway.sent).toHaveLength(1);
    });

    it('leaves the campaign `sending` if the claim cannot be given back either', async () => {
      sends.failNextCreate = true;
      campaigns.failNextWriteOf = 'failed';

      // The caller still sees the first failure, not the second.
      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(StoreDown);
      expect(await status()).toBe('sending');
      expect(gateway.calls).toBe(0);
    });
  });

  describe('two requests at once', () => {
    it('submits once: one request claims the campaign, the other is refused', async () => {
      const results = await Promise.allSettled([send.execute(campaignId), send.execute(campaignId)]);

      expect(gateway.calls).toBe(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(CampaignStateError);
      // The loser wrote nothing.
      expect(sends.created).toBe(1);
      expect(outcomes.rowsCreated).toBe(AUDIENCE.length);
      expect(await status()).toBe('sent');
    });

    it('an edit that read the draft before the claim cannot write `draft` back over it', async () => {
      gateway.loseNextAnswer();
      const update = container.get<UpdateCampaign>(CAMPAIGN_TYPES.UpdateCampaign);

      // Start the edit and the send together: both read `draft`.
      const [edited] = await Promise.allSettled([
        update.execute(campaignId, { name: 'Renamed mid-send' }),
        send.execute(campaignId),
      ]);

      // Whichever write landed first, the campaign ends claimed, never `draft`.
      expect(await status()).toBe('sending');
      if (edited.status === 'rejected') {
        expect(edited.reason).toBeInstanceOf(CampaignStateError);
      }
      await expect(send.execute(campaignId)).rejects.toBeInstanceOf(CampaignSendUnresolvedError);
      expect(gateway.calls).toBe(1);
    });
  });

  // The way out of `sending`. Only someone who can look at the provider knows
  // what happened, so they say — and `not-sent`, the answer that makes the
  // campaign sendable again, is refused whenever cablegram knows better.
  describe('resolving a send left in `sending`', () => {
    const resolve = (outcome: 'sent' | 'not-sent') =>
      container.get<ResolveSend>(CAMPAIGN_TYPES.ResolveSend).execute({ campaignId, outcome });

    /** Long enough that the original request cannot still be running. */
    const waitItOut = () => clock.advance(NOT_SENT_WAIT_MS + 1);

    it('has nothing to resolve unless the campaign is `sending`', async () => {
      await expect(resolve('sent')).rejects.toBeInstanceOf(CampaignStateError);
      await expect(resolve('not-sent')).rejects.toBeInstanceOf(CampaignStateError);
      expect(await status()).toBe('draft');

      await expect(
        container
          .get<ResolveSend>(CAMPAIGN_TYPES.ResolveSend)
          .execute({ campaignId: 'missing', outcome: 'sent' }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
    });

    describe('as sent', () => {
      it('completes the campaign and raises its recipients, with no provider call', async () => {
        gateway.loseNextAnswer();
        await send.execute(campaignId).catch(() => undefined);

        const resolved = await resolve('sent');

        expect(resolved.status).toBe('sent');
        expect(resolved.recipientCount).toBe(AUDIENCE.length);
        expect(resolved.sentAt).not.toBeNull();
        const { stats } = await container.get<GetSend>(CAMPAIGN_TYPES.GetSend).execute(campaignId);
        expect(stats.accepted).toBe(AUDIENCE.length);

        // And it is now an ordinary sent campaign: sending again is a no-op.
        expect((await send.execute(campaignId)).status).toBe('sent');
        expect(gateway.calls).toBe(1);
      });

      it('is refused when no send record was ever opened — nothing was submitted', async () => {
        sends.failNextCreate = true;
        campaigns.failNextWriteOf = 'failed';
        await send.execute(campaignId).catch(() => undefined);
        expect(await status()).toBe('sending');

        await expect(resolve('sent')).rejects.toThrow(/nothing was submitted/);
        expect(await status()).toBe('sending');
      });
    });

    describe('as not-sent', () => {
      it('returns the campaign to `failed`, from which it sends once', async () => {
        gateway.dropNext();
        await send.execute(campaignId).catch(() => undefined);
        expect(await status()).toBe('sending');
        waitItOut();

        const resolved = await resolve('not-sent');

        expect(resolved.status).toBe('failed');
        expect((await send.execute(campaignId)).status).toBe('sent');
        expect(gateway.sent).toHaveLength(1);
      });

      it('is refused while the original request may still be running', async () => {
        gateway.dropNext();
        await send.execute(campaignId).catch(() => undefined);

        await expect(resolve('not-sent')).rejects.toThrow(/may still be in progress/);
        clock.advance(NOT_SENT_WAIT_MS - 60_000);
        await expect(resolve('not-sent')).rejects.toBeInstanceOf(CampaignStateError);
        expect(await status()).toBe('sending');

        clock.advance(60_001);
        expect((await resolve('not-sent')).status).toBe('failed');
      });

      it('is refused when the provider acknowledgment is stored', async () => {
        campaigns.failNextWriteOf = 'sent';
        await send.execute(campaignId).catch(() => undefined);
        expect(await status()).toBe('sending');
        waitItOut();

        await expect(resolve('not-sent')).rejects.toThrow(/acknowledged this send \(bulk request in-memory-1\)/);
        expect(await status()).toBe('sending');
      });

      it('is refused once delivery events have arrived for the send', async () => {
        gateway.loseNextAnswer();
        await send.execute(campaignId).catch(() => undefined);
        await container.get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents).execute({
          RecordType: 'Delivery',
          Recipient: AUDIENCE[0],
          MessageID: 'm-1',
          DeliveredAt: '2026-07-20T10:00:00Z',
          Tag: campaignId,
        });
        waitItOut();

        await expect(resolve('not-sent')).rejects.toThrow(/delivery events have arrived for 1 recipient/);
        expect(await status()).toBe('sending');
        // The right answer is still open.
        expect((await resolve('sent')).status).toBe('sent');
      });

      it('settles a campaign whose send record was never opened', async () => {
        sends.failNextCreate = true;
        campaigns.failNextWriteOf = 'failed';
        await send.execute(campaignId).catch(() => undefined);
        waitItOut();

        expect((await resolve('not-sent')).status).toBe('failed');
        expect((await send.execute(campaignId)).status).toBe('sent');
        expect(gateway.sent).toHaveLength(1);
      });
    });
  });
});
