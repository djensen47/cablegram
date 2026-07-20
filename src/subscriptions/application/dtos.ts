import type { MergeFields, SubscriptionStatus } from '../domain/subscription.js';

/**
 * Application-layer input DTOs: plain, validated primitives handed to use cases
 * (ADR-006 — validation happens at the HTTP edge; use cases never see a Hono
 * `Context`). Output is the domain `Subscription`, mapped to a response DTO by
 * the presentation layer — entities are never serialized directly (ADR-004).
 */

export interface SubscribeInput {
  newsletterId: string;
  email: string;
  mergeFields?: MergeFields;
  tags?: string[];
  /**
   * Per-newsletter opt-in toggle. `true` (the default) → the subscription is
   * created `pending` and one confirmation email is sent; `false` (single
   * opt-in) → it is created `subscribed` with no email.
   */
  doubleOptIn?: boolean;
}

export interface ListSubscriptionsInput {
  newsletterId: string;
  status?: SubscriptionStatus;
  tag?: string;
  /** Page size requested by the caller. */
  limit: number;
  cursor?: string;
}
