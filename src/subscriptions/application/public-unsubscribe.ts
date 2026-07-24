import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { verifyUnsubscribeToken } from '../../shared/auth/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { Subscription } from '../domain/subscription.js';
import { InvalidUnsubscribeTokenError } from '../domain/errors.js';
import type { SubscriptionRepository } from './subscription-repository.js';

/**
 * The public, token-authenticated unsubscribe (ADR-015) — the counterpart to the
 * operator `Unsubscribe` (which is JWT-guarded and looked up by id path param).
 * Here the caller is the subscriber (or their mail client) with **no session**;
 * a stateless HMAC token, bound to `(newsletterId, subscriptionId)`, is the only
 * credential. A forged/mismatched token is rejected; a valid token whose row is
 * gone succeeds quietly (idempotent + non-revealing — it never leaks whether an
 * address is subscribed). This flips per-newsletter status only; it does **not**
 * touch the global `deliverability` suppression list (that is for hard
 * bounces/complaints).
 */
@injectable()
export class PublicUnsubscribe {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  /**
   * Verify the token and opt the subscription out. Returns the affected
   * subscription (so the caller can echo the address on a redirect), or `null`
   * when the token is valid but the row no longer exists. Throws
   * `InvalidUnsubscribeTokenError` when the token does not verify.
   */
  async execute(newsletterId: string, subscriptionId: string, token: string): Promise<Subscription | null> {
    if (
      !verifyUnsubscribeToken(this.config.unsubscribe.tokenSecret, newsletterId, subscriptionId, token)
    ) {
      throw new InvalidUnsubscribeTokenError();
    }

    const subscription = await this.repository.findById(subscriptionId);
    // A verified token whose row is missing (or somehow cross-newsletter) is a
    // quiet no-op: the link was legitimately issued, so we neither error nor
    // reveal the row's absence.
    if (subscription === null || subscription.newsletterId !== newsletterId) {
      return null;
    }

    subscription.unsubscribe(this.clock.now()); // idempotent on an already-unsubscribed row
    await this.repository.update(subscription);
    return subscription;
  }
}
