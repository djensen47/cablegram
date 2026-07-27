import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { SubscriptionRepository } from './subscription-repository.js';

/** The provider-driven outcomes that change a membership's status (ADR-018). */
export type SubscriptionOutcome = 'unsubscribed' | 'bounced' | 'complained';

/**
 * Records a delivery outcome against **one newsletter's** membership, addressed
 * by `(newsletterId, email)` rather than by subscription id.
 *
 * This exists for provider-driven events: a bounce or spam complaint arrives
 * from Postmark carrying only an address, and it concerns exactly the newsletter
 * whose campaign was sent (ADR-018). The id-keyed use cases cannot serve that
 * caller — there is no subscription id in a webhook payload.
 *
 * **This is the per-newsletter half of the story.** A hard bounce *also* goes on
 * the global suppression list, but that is a separate write by a separate
 * context, because a dead mailbox is a fact about the address while a complaint
 * is a fact about this relationship. A complaint never reaches the global list.
 *
 * Deliberately **quiet**: an address with no membership in that newsletter is a
 * no-op, not an error. A webhook receiver must always succeed (ADR-008) or the
 * provider retries for hours, and an event for a since-deleted subscription is a
 * normal race rather than a fault. Idempotent for the same reason — the domain's
 * transitions are all no-ops when already in the target state.
 *
 * Returns whether a row actually changed, so callers can log meaningfully.
 */
@injectable()
export class MarkSubscriptionOutcome {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(
    newsletterId: string,
    email: string,
    outcome: SubscriptionOutcome,
  ): Promise<boolean> {
    // The repository's compound key stores normalized addresses, so the lookup
    // must normalize too — provider payloads echo whatever casing was sent.
    const subscription = await this.repository.findByNewsletterAndEmail(
      newsletterId,
      normalizeEmailAddress(email),
    );
    if (subscription === null) return false;

    const before = subscription.status;
    const now = this.clock.now();
    switch (outcome) {
      case 'unsubscribed':
        subscription.unsubscribe(now);
        break;
      case 'bounced':
        subscription.markBounced(now);
        break;
      case 'complained':
        subscription.markComplained(now);
        break;
    }

    if (subscription.status === before) return false;
    await this.repository.update(subscription);
    return true;
  }
}
