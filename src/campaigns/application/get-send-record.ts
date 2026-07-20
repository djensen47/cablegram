import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignId } from '../domain/campaign.js';
import type { SendRecord } from '../domain/send-record.js';
import { CampaignNotFoundError, SendRecordNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendRecordRepository } from './send-record-repository.js';

/**
 * Fetches a campaign's send record (per-recipient outcomes). Throws
 * `CampaignNotFoundError` if the campaign is unknown, or
 * `SendRecordNotFoundError` if it has never been sent.
 */
@injectable()
export class GetSendRecord {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendRecordRepository)
    private readonly sendRecords: SendRecordRepository,
  ) {}

  async execute(campaignId: CampaignId): Promise<SendRecord> {
    const campaign = await this.campaigns.findById(campaignId);
    if (campaign === null) {
      throw new CampaignNotFoundError(campaignId);
    }
    if (campaign.sendId === null) {
      throw new SendRecordNotFoundError(campaignId);
    }
    const record = await this.sendRecords.findById(campaign.sendId);
    if (record === null) {
      throw new SendRecordNotFoundError(campaignId);
    }
    return record;
  }
}
