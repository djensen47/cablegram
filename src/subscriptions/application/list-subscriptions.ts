import { inject, injectable } from 'inversify';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { Subscription } from '../domain/subscription.js';
import type { SubscriptionRepository } from './subscription-repository.js';
import type { ListSubscriptionsInput } from './dtos.js';

/**
 * Lists a newsletter's subscriptions for one page, optionally narrowed by a
 * query-time status/tag filter. Fetches `limit + 1` rows so the presentation
 * layer can tell whether a next page exists and derive its cursor (`toPage`).
 */
@injectable()
export class ListSubscriptions {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
  ) {}

  async execute(input: ListSubscriptionsInput): Promise<Subscription[]> {
    return this.repository.list({
      newsletterId: input.newsletterId,
      status: input.status,
      tag: input.tag,
      limit: input.limit + 1,
      cursor: input.cursor,
    });
  }
}
