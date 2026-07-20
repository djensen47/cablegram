import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { Subscription } from '../domain/subscription.js';
import { SubscriptionNotFoundError } from '../domain/errors.js';
import type { SubscriptionRepository } from './subscription-repository.js';

/**
 * Confirm a pending double-opt-in subscription (`pending → subscribed`). The
 * subscription is looked up by id and must belong to the addressed newsletter,
 * so a valid id from another newsletter cannot be confirmed across the boundary.
 * Idempotent on an already-confirmed row; the aggregate rejects confirming an
 * unsubscribed one.
 */
@injectable()
export class ConfirmSubscription {
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

    subscription.confirm(this.clock.now());
    await this.repository.update(subscription);
    return subscription;
  }
}
