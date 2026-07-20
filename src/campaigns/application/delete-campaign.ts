import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignId } from '../domain/campaign.js';
import { CampaignNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';

/** Deletes a campaign by id, or throws `CampaignNotFoundError` if absent. */
@injectable()
export class DeleteCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly repository: CampaignRepository,
  ) {}

  async execute(id: CampaignId): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      throw new CampaignNotFoundError(id);
    }
  }
}
