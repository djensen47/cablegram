import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { Campaign } from '../domain/campaign.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { ListCampaignsInput } from './dtos.js';

/**
 * Lists campaigns for one page. Fetches `limit + 1` rows so the presentation
 * layer can tell whether a next page exists and derive its cursor (`toPage`).
 */
@injectable()
export class ListCampaigns {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly repository: CampaignRepository,
  ) {}

  async execute(input: ListCampaignsInput): Promise<Campaign[]> {
    return this.repository.list({
      newsletterId: input.newsletterId,
      status: input.status,
      limit: input.limit + 1,
      cursor: input.cursor,
    });
  }
}
