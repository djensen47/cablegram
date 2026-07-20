import { inject, injectable } from 'inversify';
import { ResolveRecipients, SUBSCRIPTION_TYPES } from '../../subscriptions/index.js';
import type { CampaignSegment } from '../domain/campaign.js';
import type { CampaignRecipient, RecipientResolver } from '../application/recipient-resolver.js';

/**
 * The adapter fulfilling the `RecipientResolver` port over the `subscriptions`
 * facade (ADR-005 #3 + the ADR-011 DAG edge `campaigns → subscriptions`) —
 * gate 1 of the send path. It calls `ResolveRecipients` (subscribed-only,
 * segment-narrowed) and passes the projections straight through; suppression is
 * a separate gate applied afterwards in the send use case.
 */
@injectable()
export class FacadeRecipientResolver implements RecipientResolver {
  constructor(
    @inject(SUBSCRIPTION_TYPES.ResolveRecipients)
    private readonly resolveRecipients: ResolveRecipients,
  ) {}

  async resolve(newsletterId: string, segment: CampaignSegment): Promise<CampaignRecipient[]> {
    const recipients = await this.resolveRecipients.execute(newsletterId, { tags: segment.tags });
    return recipients.map((r) => ({ address: r.address, mergeModel: r.mergeModel }));
  }
}
