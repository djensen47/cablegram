import { inject, injectable } from 'inversify';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type {
  RecipientProjection,
  SubscriptionRepository,
  SubscriptionSegment,
} from './subscription-repository.js';

/**
 * Resolve the send targets for a newsletter (the seam `campaigns` calls at send
 * time, ADR-008): **only `subscribed`** rows, narrowed by an optional
 * query-time segment, projected to `{ address, mergeModel }`. Suppression is a
 * *separate* gate applied downstream in `campaigns` (never here) — this returns
 * the subscribed set, nothing more.
 */
@injectable()
export class ResolveRecipients {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
  ) {}

  async execute(newsletterId: string, segment?: SubscriptionSegment): Promise<RecipientProjection[]> {
    return this.repository.resolveRecipients(newsletterId, segment);
  }
}
