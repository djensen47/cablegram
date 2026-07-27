import type { SubscriptionOutcomeSignal } from '../domain/recipient-outcome.js';

/**
 * A consumer-owned port over the `subscriptions` context (ADR-001), for the
 * **write** direction — `RecipientResolver` covers reads.
 *
 * It exists because a provider event carries a consequence for two different
 * contexts, and they must not be conflated (ADR-018):
 *
 *  - `deliverability` — the global, address-keyed deny list. Permanent bounces
 *    only, because a dead mailbox is dead for every newsletter.
 *  - `subscriptions`  — this newsletter's membership status. Bounces *and*
 *    complaints, because a complaint about one publication says nothing about
 *    the others.
 *
 * Reaches the `subscriptions` facade along the DAG edge
 * `campaigns → subscriptions` (ADR-011).
 */
export interface SubscriberGateway {
  /**
   * Record a delivery outcome against one newsletter's membership. Quiet when
   * no membership exists — a webhook must never fail on a since-deleted row.
   */
  record(newsletterId: string, address: string, outcome: SubscriptionOutcomeSignal): Promise<void>;
}
