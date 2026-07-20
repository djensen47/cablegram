import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { Subscription } from '../domain/subscription.js';
import { SubscriptionNotFoundError } from '../domain/errors.js';
import type { SubscriptionRepository } from './subscription-repository.js';

/**
 * Opt a subscription out (`* → unsubscribed`). The row is kept, not deleted, so
 * a later re-subscribe revives it (ADR-011) and the address stays recorded.
 * Looked up by id, scoped to the addressed newsletter; idempotent.
 */
@injectable()
export class Unsubscribe {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(newsletterId: string, id: string): Promise<Subscription> {
    const subscription = await this.repository.findById(id);
    if (subscription === null || subscription.newsletterId !== newsletterId) {
      throw new SubscriptionNotFoundError(id);
    }

    subscription.unsubscribe(this.clock.now());
    await this.repository.update(subscription);
    return subscription;
  }
}
