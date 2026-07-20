import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { Campaign, CampaignId } from '../domain/campaign.js';
import { CampaignNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';

/** Fetches one campaign by id, or throws `CampaignNotFoundError`. */
@injectable()
export class GetCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly repository: CampaignRepository,
  ) {}

  async execute(id: CampaignId): Promise<Campaign> {
    const campaign = await this.repository.findById(id);
    if (campaign === null) {
      throw new CampaignNotFoundError(id);
    }
    return campaign;
  }
}
