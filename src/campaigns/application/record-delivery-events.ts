import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { parseProviderEvent, type DeliveryEvent } from '../../shared/email/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendRecordRepository } from './send-record-repository.js';
import type { SuppressionGateway } from './suppression-gateway.js';

/**
 * Applies a Postmark webhook body to the send records it concerns (ADR-008).
 * The raw payload is normalized by the leaf `email` module
 * (`parseProviderEvent`); each event carries its campaign id in the `tag` echoed
 * back from the send. For every event this:
 *  - records the outcome on the campaign's send record (idempotent, keyed on
 *    `(messageId|address, type)` — duplicate/out-of-order delivery is tolerated);
 *  - adds hard-bounce / spam-complaint addresses to cablegram's own suppression
 *    list (via the `deliverability` facade);
 *  - refreshes the campaign's aggregate stats from the (authoritative) record.
 *
 * Writes are sequential and each independently idempotent — no cross-document
 * transaction is required (ADR-007). Unknown campaigns/records and untagged
 * events are tolerated (skipped), never fatal, so the receiver always 200s.
 */
@injectable()
export class RecordDeliveryEvents {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendRecordRepository)
    private readonly sendRecords: SendRecordRepository,
    @inject(CAMPAIGN_TYPES.SuppressionGateway)
    private readonly suppression: SuppressionGateway,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(rawWebhookPayload: unknown): Promise<void> {
    const events = parseProviderEvent(rawWebhookPayload);

    // Group by campaign id (the send tag) so each campaign's record is loaded
    // and written at most once per request.
    const byCampaign = new Map<string, DeliveryEvent[]>();
    for (const event of events) {
      if (event.tag === null) continue; // untagged: cannot correlate — tolerate
      const list = byCampaign.get(event.tag);
      if (list === undefined) byCampaign.set(event.tag, [event]);
      else list.push(event);
    }

    for (const [campaignId, campaignEvents] of byCampaign) {
      const campaign = await this.campaigns.findById(campaignId);
      if (campaign === null || campaign.sendId === null) continue;
      const record = await this.sendRecords.findById(campaign.sendId);
      if (record === null) continue;

      let changed = false;
      for (const event of campaignEvents) {
        const result = record.applyEvent(
          { type: event.type, address: event.email, messageId: event.messageId },
          this.clock.now(),
        );
        if (result.newlyApplied) changed = true;
        if (result.suppress !== null) {
          await this.suppression.suppress(result.suppress);
        }
      }

      if (changed) {
        await this.sendRecords.update(record);
        campaign.applyStats(record.stats(), this.clock.now());
        await this.campaigns.update(campaign);
      }
    }
  }
}
