import { inject, injectable } from 'inversify';
import { MarkSubscriptionOutcome, SUBSCRIPTION_TYPES } from '../../subscriptions/index.js';
import type { SubscriptionOutcomeSignal } from '../domain/recipient-outcome.js';
import type { SubscriberGateway } from '../application/subscriber-gateway.js';

/**
 * The adapter fulfilling `SubscriberGateway` over the `subscriptions` facade
 * (ADR-005 #3 + the ADR-011 DAG edge `campaigns → subscriptions`).
 *
 * A thin pass-through: the signal vocabulary (`bounced` | `complained`) is
 * deliberately a subset of the subscriptions context's own outcome vocabulary,
 * so no translation is needed. `campaigns` cannot express `unsubscribed` here —
 * that comes from the subscriber, not from a delivery event.
 */
@injectable()
export class FacadeSubscriberGateway implements SubscriberGateway {
  constructor(
    @inject(SUBSCRIPTION_TYPES.MarkSubscriptionOutcome)
    private readonly mark: MarkSubscriptionOutcome,
  ) {}

  async record(
    newsletterId: string,
    address: string,
    outcome: SubscriptionOutcomeSignal,
  ): Promise<void> {
    await this.mark.execute(newsletterId, address, outcome);
  }
}
