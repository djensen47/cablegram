import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import { Campaign } from '../domain/campaign.js';
import { CampaignNewsletterNotFoundError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { NewsletterGateway } from './newsletter-gateway.js';
import type { CreateCampaignInput } from './dtos.js';

/**
 * Creates a campaign (status `draft`). Validates the target newsletter exists
 * via the consumer-owned `NewsletterGateway` port (ADR-011 DAG edge), builds a
 * validated aggregate — enforcing exactly one content source (template ref or
 * inline bodies) — and persists it. The template reference (if any) is resolved
 * lazily at send time, so a template may be authored after the campaign.
 */
@injectable()
export class CreateCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly repository: CampaignRepository,
    @inject(CAMPAIGN_TYPES.NewsletterGateway)
    private readonly newsletters: NewsletterGateway,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: CreateCampaignInput): Promise<Campaign> {
    const sender = await this.newsletters.find(input.newsletterId);
    if (sender === null) {
      throw new CampaignNewsletterNotFoundError(input.newsletterId);
    }

    const campaign = Campaign.create({
      id: newId(),
      newsletterId: input.newsletterId,
      name: input.name,
      templateId: input.templateId,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      segmentTags: input.segmentTags,
      scheduledAt: input.scheduledAt,
      now: this.clock.now(),
    });

    await this.repository.create(campaign);
    return campaign;
  }
}
