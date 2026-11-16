import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import { SENDABLE_STATUSES, type Campaign, type CampaignId } from '../domain/campaign.js';
import { CampaignNotFoundError, CampaignStateError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { UpdateCampaignInput } from './dtos.js';

/**
 * Applies a partial change set to a not-yet-sent campaign and persists it. The
 * aggregate refuses edits once it is `sending`/`sent` (`CampaignStateError`) and
 * re-validates the content source on every change.
 *
 * The write repeats that check against the stored row (ADR-035). Without it, an
 * edit that read `draft` just before a send claimed the campaign would write
 * `draft` back over `sending`, and the campaign could then be sent a second
 * time.
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
    if (await this.repository.saveIfStatus(campaign, SENDABLE_STATUSES)) {
      return campaign;
    }

    // The row changed between the read and the write. Say which way.
    const current = await this.repository.findById(id);
    if (current === null) {
      throw new CampaignNotFoundError(id);
    }
    throw new CampaignStateError(`cannot edit a campaign in status "${current.status}"`);
  }
}
