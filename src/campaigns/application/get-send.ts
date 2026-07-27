import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignId, CampaignStats } from '../domain/campaign.js';
import type { Send } from '../domain/send.js';
import { CampaignNotFoundError, SendNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendRepository } from './send-repository.js';
import type { RecipientOutcomeRepository } from './recipient-outcome-repository.js';

export interface SendSummary {
  send: Send;
  /** Counted from the outcomes collection at read time (ADR-019). */
  stats: CampaignStats;
}

/**
 * Fetches a campaign's send: the submission facts plus **live** aggregate
 * stats.
 *
 * The stats are computed here rather than read off the campaign, because the
 * campaign's copy is a snapshot taken when the send was submitted. Keeping it
 * live would mean rewriting the campaign on every one of ~50k webhooks — the
 * write amplification ADR-019 exists to remove. Per-recipient rows are **not**
 * returned: at 18k recipients that is a multi-megabyte response, so they are a
 * separate paginated read (`ListRecipientOutcomes`).
 */
@injectable()
export class GetSend {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendRepository)
    private readonly sends: SendRepository,
    @inject(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    private readonly outcomes: RecipientOutcomeRepository,
  ) {}

  async execute(campaignId: CampaignId): Promise<SendSummary> {
    const campaign = await this.campaigns.findById(campaignId);
    if (campaign === null) {
      throw new CampaignNotFoundError(campaignId);
    }
    if (campaign.sendId === null) {
      throw new SendNotFoundError(campaignId);
    }
    const send = await this.sends.findById(campaign.sendId);
    if (send === null) {
      throw new SendNotFoundError(campaignId);
    }
    return { send, stats: await this.outcomes.stats(send.id) };
  }
}
