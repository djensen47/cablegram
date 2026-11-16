import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import {
  EMAIL_TYPES,
  EmailRejectedError,
  type DeliveryGateway,
  type SendAcknowledgment,
} from '../../shared/email/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import { SENDABLE_STATUSES, type Campaign, type CampaignId } from '../domain/campaign.js';
import { Send } from '../domain/send.js';
import { RecipientOutcome } from '../domain/recipient-outcome.js';
import {
  CampaignNotFoundError,
  CampaignNewsletterNotFoundError,
  CampaignChannelMissingError,
  CampaignSendOutcomeUnknownError,
  CampaignSendRejectedError,
  CampaignSendUnresolvedError,
  CampaignStateError,
} from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendRepository } from './send-repository.js';
import type { RecipientOutcomeRepository } from './recipient-outcome-repository.js';
import type { NewsletterGateway } from './newsletter-gateway.js';
import type { RecipientResolver } from './recipient-resolver.js';
import type { SuppressionGateway } from './suppression-gateway.js';
import type { MessageRenderer } from './message-renderer.js';
import { unsubscribeHeaders } from './unsubscribe-headers.js';

/**
 * The send-now pipeline (ADR-008) — the integrator. Resolves recipients, applies
 * **both** send gates, renders once, and hands a single broadcast to the
 * provider:
 *
 *   subscriptions.resolveRecipients      → gate 1 (subscribed, segment-narrowed)
 *   deliverability.filterSuppressed      → gate 2 (drop suppressed addresses)
 *   templates render (once, empty model) → one shared rendered message
 *   email.send (one Bulk call)           → Postmark owns the fan-out
 *
 * Suppression is enforced **here**, never in the leaf `email` adapter.
 *
 * **Calling this twice must never mail the list twice** (ADR-035). The provider
 * call cannot be made idempotent — Postmark's Bulk API takes no idempotency key
 * — so the guarantee is built around it:
 *
 *  - One request **claims** the campaign (`draft`/`failed` → `sending`) with a
 *    conditional write. A second request, overlapping or later, does not match.
 *  - The campaign becomes `failed` — sendable again — only when the send is
 *    **known not to have gone out**: the provider refused it, or nothing was
 *    submitted yet.
 *  - When the provider gave **no definite answer**, the campaign stays
 *    `sending`. That is not retried from here; an operator settles it
 *    (`ResolveSend`).
 *  - Once the provider **accepts**, nothing marks the campaign `failed`. A
 *    write that fails afterwards leaves work a repeated call finishes without
 *    calling the provider again.
 */
@injectable()
export class SendCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendRepository)
    private readonly sends: SendRepository,
    @inject(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    private readonly outcomes: RecipientOutcomeRepository,
    @inject(CAMPAIGN_TYPES.NewsletterGateway)
    private readonly newsletters: NewsletterGateway,
    @inject(CAMPAIGN_TYPES.RecipientResolver)
    private readonly recipients: RecipientResolver,
    @inject(CAMPAIGN_TYPES.SuppressionGateway)
    private readonly suppression: SuppressionGateway,
    @inject(CAMPAIGN_TYPES.MessageRenderer)
    private readonly renderer: MessageRenderer,
    @inject(EMAIL_TYPES.DeliveryGateway) private readonly delivery: DeliveryGateway,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(id: CampaignId): Promise<Campaign> {
    const campaign = await this.campaigns.findById(id);
    if (campaign === null) {
      throw new CampaignNotFoundError(id);
    }
    // Re-sending an already-sent campaign is a no-op (idempotent).
    if (campaign.isSent) {
      return campaign;
    }
    // An earlier call already claimed this campaign. Decided here, before
    // anything is resolved or written: the only thing a repeated call may do is
    // finish that send's bookkeeping — never start another send.
    if (campaign.isSending) {
      return this.resume(campaign);
    }

    // Fail fast, before any state change: the sender identity must exist.
    const sender = await this.newsletters.find(campaign.newsletterId);
    if (sender === null) {
      throw new CampaignNewsletterNotFoundError(campaign.newsletterId);
    }
    // …and so must the channel it goes through (ADR-030). Checked here, before
    // the campaign is claimed, so a newsletter that predates the field leaves
    // the campaign exactly as it was.
    if (sender.campaignChannel === null) {
      throw new CampaignChannelMissingError(campaign.newsletterId);
    }
    const sendingChannel = sender.campaignChannel;

    // Gate 1: subscribed recipients narrowed by the query-time segment.
    const resolved = await this.recipients.resolve(campaign.newsletterId, campaign.segment());
    // Gate 2: drop addresses on the suppression list (subscribed AND not suppressed).
    const suppressed = new Set(
      await this.suppression.filterSuppressed(resolved.map((r) => r.address)),
    );
    // Keep the whole recipient (address + subscriptionId) past the gate so each
    // survivor can carry its own List-Unsubscribe header (ADR-015).
    const allowed = resolved.filter((r) => !suppressed.has(r.address));

    // Render once — one shared message for the whole broadcast (may throw
    // CampaignContentError). Done before the claim so a bad template leaves the
    // campaign editable.
    const message = await this.renderer.render(campaign.contentRef(), {});

    const sendId = newId();
    const now = this.clock.now();

    // The claim. Everything above was read some time ago, and another request
    // may have read the same `draft`; the store lets exactly one of them make
    // this write (ADR-035). The loser stops here, having written nothing.
    campaign.markSending(sendId, now);
    if (!(await this.campaigns.saveIfStatus(campaign, SENDABLE_STATUSES))) {
      throw new CampaignStateError('another request is already sending this campaign');
    }

    // Durable ledger opened BEFORE the provider call (crash recovery). The send
    // document holds the submission facts; each recipient gets its own row, so
    // webhooks can later update one document apiece instead of rewriting a
    // multi-megabyte embedded array (ADR-019).
    const send = Send.create({
      id: sendId,
      campaignId: campaign.id,
      recipientCount: allowed.length,
      now,
    });
    try {
      await this.sends.create(send);
      await this.outcomes.createMany(
        allowed.map((r) =>
          RecipientOutcome.create({
            id: newId(),
            sendId,
            campaignId: campaign.id,
            address: r.address,
            now,
          }),
        ),
      );
    } catch (err) {
      // Nothing has been handed to the provider, so this is known not to have
      // sent anything: give the claim back.
      await this.release(campaign);
      throw err;
    }

    // Nothing to submit means nothing can be unknown.
    if (allowed.length === 0) {
      return this.complete(campaign, send);
    }

    let ack: SendAcknowledgment;
    try {
      ack = await this.delivery.send({
        from: {
          fromName: sender.fromName,
          fromEmail: sender.fromEmail,
          replyTo: sender.replyTo,
        },
        content: {
          subject: message.subject,
          htmlBody: message.htmlBody,
          textBody: message.textBody,
        },
        recipients: allowed.map((r) => {
          const headers = unsubscribeHeaders(
            this.config,
            campaign.newsletterId,
            r.subscriptionId,
            r.address,
          );
          return headers === undefined ? { email: r.address } : { email: r.address, headers };
        }),
        // Newsletters are broadcasts (ADR-008): broadcast token, through the
        // newsletter's own channel (ADR-030).
        category: 'broadcast',
        sendingChannel,
        // Echoed back on webhooks so events correlate to this campaign.
        tag: campaign.id,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // The provider answered, and the answer was no. Nothing was accepted, so
      // the campaign can safely be sent again.
      if (err instanceof EmailRejectedError) {
        await this.release(campaign);
        throw new CampaignSendRejectedError(campaign.id, reason, { cause: err });
      }
      // Anything else leaves open that the provider has the broadcast. The
      // campaign stays `sending`: marking it `failed` here is what used to let
      // a retry mail the whole list a second time.
      throw new CampaignSendOutcomeUnknownError(campaign.id, reason, { cause: err });
    }

    // Accepted. From here on the broadcast is going out whatever happens next,
    // so no failure below may make the campaign sendable again. The
    // acknowledgment is stored first: it is the proof a repeated call needs to
    // finish the rest without asking the provider (see `resume`).
    send.markSubmitted(ack.bulkRequestId, new Date(ack.submittedAt), this.clock.now());
    await this.sends.update(send);
    return this.complete(campaign, send);
  }

  /**
   * A repeated call on a campaign that is already `sending`.
   *
   * If the stored send carries the provider's acknowledgment, the provider has
   * the broadcast and only the bookkeeping after it is missing — finish that,
   * with no provider call. Otherwise nothing here can tell a send that is still
   * running from one whose answer was lost, so it is refused.
   */
  private async resume(campaign: Campaign): Promise<Campaign> {
    const send = campaign.sendId === null ? null : await this.sends.findById(campaign.sendId);
    if (send !== null && send.bulkRequestId !== null) {
      return this.complete(campaign, send);
    }
    throw new CampaignSendUnresolvedError(campaign.id, campaign.updatedAt);
  }

  /**
   * The bookkeeping after the provider has the broadcast: raise the recipients
   * to `accepted`, then mark the campaign `sent`. Every step can be repeated,
   * and everything it needs is on the stored send — which is what lets a later
   * call run it again after a failure part-way through.
   */
  private async complete(campaign: Campaign, send: Send): Promise<Campaign> {
    const now = this.clock.now();
    // One bulk update raises every still-`pending` recipient to `accepted`.
    // Per-recipient outcomes arrive later via webhooks (ADR-008).
    await this.outcomes.markAccepted(send.id, now);

    // All the campaign keeps is how many addresses went out. Delivery outcomes
    // are counted from the outcomes collection on read, rather than rewritten
    // onto the campaign ~50k times per send (ADR-019 §3).
    campaign.markSent(send.recipientCount, now);
    if (await this.campaigns.saveIfStatus(campaign, ['sending'])) {
      return campaign;
    }

    // The stored campaign is no longer `sending`. If another call finished this
    // same job first, that is success.
    const current = await this.campaigns.findById(campaign.id);
    if (current !== null && current.isSent) {
      return current;
    }
    throw new CampaignStateError(
      `the provider accepted this send, but the campaign is now ` +
        `${current === null ? 'deleted' : `in status "${current.status}"`}`,
    );
  }

  /**
   * Give the claim back after a send that is known not to have gone out. If
   * this write fails too, the campaign is left `sending` — the safe side — and
   * the caller still gets the original error rather than this one.
   */
  private async release(campaign: Campaign): Promise<void> {
    campaign.markFailed(this.clock.now());
    await this.campaigns.saveIfStatus(campaign, ['sending']).catch(() => false);
  }
}
