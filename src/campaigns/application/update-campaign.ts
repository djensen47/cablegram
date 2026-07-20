import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { Campaign, CampaignId } from '../domain/campaign.js';
import { CampaignNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { UpdateCampaignInput } from './dtos.js';

/**
 * Applies a partial change set to a not-yet-sent campaign and persists it. The
 * aggregate refuses edits once it is `sending`/`sent` (`CampaignStateError`) and
 * re-validates the content source on every change.
 */
@injectable()
export class UpdateCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly repository: CampaignRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(id: CampaignId, changes: UpdateCampaignInput): Promise<Campaign> {
    const campaign = await this.repository.findById(id);
    if (campaign === null) {
      throw new CampaignNotFoundError(id);
    }

    campaign.update(changes, this.clock.now());
    await this.repository.update(campaign);
    return campaign;
  }
}
