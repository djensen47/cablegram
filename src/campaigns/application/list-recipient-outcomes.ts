import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignId } from '../domain/campaign.js';
import type { OutcomeStatus, RecipientOutcome } from '../domain/recipient-outcome.js';
import { CampaignNotFoundError, SendNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { RecipientOutcomeRepository } from './recipient-outcome-repository.js';

export interface ListRecipientOutcomesInput {
  campaignId: CampaignId;
  statuses?: readonly OutcomeStatus[];
  limit: number;
  cursor?: string;
}

/**
 * Lists a send's per-recipient outcomes, cursor-paginated (ADR-019).
 *
 * These used to be returned inline on the send record. At 18k recipients that
 * is a multi-megabyte JSON body on a single request — the same
 * unbounded-collection-in-one-payload problem as the embedded array, just moved
 * to the wire. They are their own paginated resource instead.
 */
@injectable()
export class ListRecipientOutcomes {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    private readonly outcomes: RecipientOutcomeRepository,
  ) {}

  async execute(input: ListRecipientOutcomesInput): Promise<RecipientOutcome[]> {
    const campaign = await this.campaigns.findById(input.campaignId);
    if (campaign === null) {
      throw new CampaignNotFoundError(input.campaignId);
    }
    if (campaign.sendId === null) {
      throw new SendNotFoundError(input.campaignId);
    }
    return this.outcomes.list({
      sendId: campaign.sendId,
      statuses: input.statuses,
      limit: input.limit,
      cursor: input.cursor,
    });
  }
}
