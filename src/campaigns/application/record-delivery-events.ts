import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { parseProviderEvent } from '../../shared/email/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import { effectOf } from '../domain/recipient-outcome.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { RecipientOutcomeRepository } from './recipient-outcome-repository.js';
import type { SuppressionGateway } from './suppression-gateway.js';
import type { SubscriberGateway } from './subscriber-gateway.js';

/**
 * Applies a Postmark webhook body to the recipient it concerns (ADR-008,
 * ADR-019).
 *
 * Postmark POSTs **one event, for one recipient, per request** — so this runs
 * roughly 50,000 times for an 18k-recipient campaign, and its cost per
 * invocation is the whole design constraint. It now performs:
 *
 *   1 read  — the campaign, to resolve `tag` → `sendId`
 *   1 write — one targeted, atomic update to that recipient's own document
 *   (+1 write only when the event also demands suppression)
 *
 * What it deliberately no longer does: load a multi-megabyte send record,
 * mutate an embedded array, write the whole thing back, then recompute and
 * rewrite the campaign's stats. That was ~50k whole-document rewrites per send
 * and, because the read-modify-write carried no optimistic concurrency,
 * concurrent webhooks silently overwrote each other's outcomes.
 *
 * Unknown campaigns, never-sent campaigns and untagged events are tolerated
 * (skipped), never fatal — the receiver must always 200 or Postmark retries for
 * hours (ADR-008).
 */
@injectable()
export class RecordDeliveryEvents {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    private readonly outcomes: RecipientOutcomeRepository,
    @inject(CAMPAIGN_TYPES.SuppressionGateway)
    private readonly suppression: SuppressionGateway,
    @inject(CAMPAIGN_TYPES.SubscriberGateway)
    private readonly subscribers: SubscriberGateway,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(rawWebhookPayload: unknown): Promise<void> {
    const events = parseProviderEvent(rawWebhookPayload);

    // Cache campaign lookups within one request. Postmark sends a single event
    // per request, so this is usually one entry — but the parser accepts an
    // array defensively, and a batch for one campaign should not re-read it.
    const targets = new Map<string, { sendId: string; newsletterId: string } | null>();

    for (const event of events) {
      if (event.tag === null) continue; // untagged: cannot correlate — tolerate

      let target = targets.get(event.tag);
      if (target === undefined) {
        const campaign = await this.campaigns.findById(event.tag);
        target =
          campaign === null || campaign.sendId === null
            ? null
            : { sendId: campaign.sendId, newsletterId: campaign.newsletterId };
        targets.set(event.tag, target);
      }
      if (target === null) continue; // unknown or never-sent campaign

      const { effect, suppress, subscription, dedupeKey } = effectOf({
        type: event.type,
        address: event.email,
        messageId: event.messageId,
        occurredAt: event.occurredAt,
      });

      await this.outcomes.applyEvent({
        sendId: target.sendId,
        address: event.email,
        effect,
        dedupeKey,
        now: this.clock.now(),
      });

      // Two DIFFERENT consequences, deliberately not conflated (ADR-018):
      //
      //  - the GLOBAL deny list, for permanent bounces only — the mailbox is
      //    dead for every newsletter, so re-sending burns the shared sending
      //    domain's reputation;
      //  - THIS newsletter's membership status, for bounces *and* complaints.
      //    A spam complaint about one publication is not a statement about the
      //    others, so it never reaches the global list.
      //
      // Both are driven by the **event**, not by whether a matching recipient
      // row existed: a permanent bounce we cannot correlate is still permanent.
      // Both writes are idempotent, so a replayed webhook is harmless.
      if (suppress !== null) {
        await this.suppression.suppress(suppress);
      }
      if (subscription !== null) {
        await this.subscribers.record(target.newsletterId, event.email, subscription);
      }
    }
  }
}
