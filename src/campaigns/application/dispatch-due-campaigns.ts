import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendCampaign } from './send-campaign.js';
import {
  DEFAULT_DISPATCH_BATCH,
  MAX_DISPATCH_BATCH,
  type DispatchDueCampaignsInput,
  type DispatchDueResult,
} from './dtos.js';

function clampBatch(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_DISPATCH_BATCH;
  return Math.max(1, Math.min(limit, MAX_DISPATCH_BATCH));
}

/**
 * The scheduling dispatch sweep (ADR-009's open item): what an external cron
 * calls — there is no in-process timer. Fetches up to a bounded batch of
 * `scheduled` campaigns whose time has passed and runs the ordinary
 * `SendCampaign` pipeline on each, one at a time, so a single call never
 * exceeds a function's time budget the way an unbounded loop could.
 *
 * A campaign that fails *before* `SendCampaign` ever marks it `sending` (e.g.
 * its newsletter or template reference went missing after it was scheduled)
 * would otherwise stay `scheduled` forever and get retried — and fail — on
 * every future tick. This sweep force-fails such a campaign itself so one bad
 * campaign can't wedge the batch; a campaign `SendCampaign` already marked
 * `failed` (a provider-call error) is left as `SendCampaign` left it, eligible
 * for a manual `POST /{id}/send` retry.
 */
@injectable()
export class DispatchDueCampaigns {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly repository: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendCampaign)
    private readonly send: SendCampaign,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: DispatchDueCampaignsInput = {}): Promise<DispatchDueResult[]> {
    const now = this.clock.now();
    const due = await this.repository.listDue(now, clampBatch(input.limit));

    const results: DispatchDueResult[] = [];
    for (const campaign of due) {
      try {
        const sent = await this.send.execute(campaign.id);
        results.push({ campaignId: campaign.id, status: sent.status });
      } catch {
        const after = await this.repository.findById(campaign.id);
        if (after !== null && after.status === 'scheduled') {
          after.markFailed(this.clock.now());
          await this.repository.update(after);
        }
        results.push({ campaignId: campaign.id, status: 'failed' });
      }
    }
    return results;
  }
}
