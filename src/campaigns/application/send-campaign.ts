import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { unsubscribeToken } from '../../shared/auth/index.js';
import { EMAIL_TYPES, type DeliveryGateway, type EmailHeader } from '../../shared/email/index.js';
import { PUBLIC_UNSUBSCRIBE_PATH } from '../../subscriptions/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { Campaign, CampaignId } from '../domain/campaign.js';
import { SendRecord } from '../domain/send-record.js';
import { CampaignNotFoundError, CampaignNewsletterNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendRecordRepository } from './send-record-repository.js';
import type { NewsletterGateway } from './newsletter-gateway.js';
import type { RecipientResolver } from './recipient-resolver.js';
import type { SuppressionGateway } from './suppression-gateway.js';
import type { MessageRenderer } from './message-renderer.js';


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
 * Suppression is enforced **here**, never in the leaf `email` adapter. The
 * campaign is written `sending` (with its `sendId`) and the send record opened
 * **before** the provider call, so a crash mid-send leaves a state webhooks
 * reconcile. Re-sending a `sent` campaign is a no-op; only a
 * `draft`/`failed` campaign transitions to `sending`, once.
 */
@injectable()
export class SendCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendRecordRepository)
    private readonly sendRecords: SendRecordRepository,
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

    // Fail fast, before any state change: the sender identity must exist.
    const sender = await this.newsletters.find(campaign.newsletterId);
    if (sender === null) {
      throw new CampaignNewsletterNotFoundError(campaign.newsletterId);
    }

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
    // CampaignContentError). Done before marking `sending` so a bad template
    // leaves the campaign editable.
    const message = await this.renderer.render(campaign.contentRef(), {});

    const addresses = allowed.map((r) => r.address);
    const sendId = newId();
    // Durable record opened BEFORE the provider call (crash recovery).
    const record = SendRecord.create({
      id: sendId,
      campaignId: campaign.id,
      addresses,
      now: this.clock.now(),
    });
    await this.sendRecords.create(record);

    // Persist `sending` BEFORE the provider call (ADR-008).
    campaign.markSending(sendId, this.clock.now());
    await this.campaigns.update(campaign);

    try {
      if (allowed.length > 0) {
        const ack = await this.delivery.send({
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
            const headers = this.unsubscribeHeaders(campaign.newsletterId, r.subscriptionId);
            return headers === undefined ? { email: r.address } : { email: r.address, headers };
          }),
          // Newsletters are broadcasts (ADR-008): broadcast stream + token.
          category: 'broadcast',
          // Echoed back on webhooks so events correlate to this campaign.
          tag: campaign.id,
        });
        // Async bulk submit: record the request id + submission time; the
        // gated recipients become `accepted`. Per-recipient outcomes arrive
        // later via webhooks (ADR-008).
        record.markSubmitted(ack.bulkRequestId, new Date(ack.submittedAt), this.clock.now());
        await this.sendRecords.update(record);
      }

      campaign.markSent(record.stats(), this.clock.now());
      await this.campaigns.update(campaign);
      return campaign;
    } catch (err) {
      campaign.markFailed(this.clock.now());
      await this.campaigns.update(campaign);
      throw err;
    }
  }

  /**
   * Build a recipient's RFC 8058 `List-Unsubscribe` headers (ADR-015): an
   * absolute, token-carrying URL plus the one-click marker. Returns `undefined`
   * when no public `baseUrl` is configured — the API then has nowhere to point,
   * so the send simply omits the headers. The token is a stateless HMAC bound to
   * `(newsletterId, subscriptionId)`.
   */
  private unsubscribeHeaders(
    newsletterId: string,
    subscriptionId: string,
  ): readonly EmailHeader[] | undefined {
    const base = this.config.baseUrl;
    if (base === null) return undefined;
    const token = unsubscribeToken(this.config.unsubscribe.tokenSecret, newsletterId, subscriptionId);
    const url =
      `${base}${PUBLIC_UNSUBSCRIBE_PATH}` +
      `?newsletterId=${encodeURIComponent(newsletterId)}` +
      `&subscriptionId=${encodeURIComponent(subscriptionId)}` +
      `&token=${encodeURIComponent(token)}`;
    return [
      { name: 'List-Unsubscribe', value: `<${url}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ];
  }
}
