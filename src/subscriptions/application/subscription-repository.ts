import type { MergeFields, Subscription, SubscriptionStatus } from '../domain/subscription.js';

/** A resolved send target: an address plus the merge model to render for it. */
export interface RecipientProjection {
  /** The subscription's id — carried so the send path can mint a per-recipient
   * unsubscribe token (ADR-015). */
  readonly subscriptionId: string;
  readonly address: string;
  readonly mergeModel: MergeFields;
}

/**
 * A query-time segment (ADR-011): not a materialized list, just a predicate
 * evaluated when recipients are resolved. `tags` matches subscriptions carrying
 * **every** listed tag (AND); an empty/absent segment matches all subscribed.
 */
export interface SubscriptionSegment {
  readonly tags?: readonly string[];
}

/** Options for a forward-only, cursor-paginated list scoped to one newsletter. */
export interface ListSubscriptionsOptions {
  newsletterId: string;
  /** Optional query-time filters (not materialized segments). */
  status?: SubscriptionStatus;
  tag?: string;
  /** Max rows to return. Callers pass `pageSize + 1` to detect a next page. */
  limit: number;
  /** Exclusive lower bound: return subscriptions whose id sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for subscriptions. Lives in `application/` next to its
 * consumers (ADR-001) — the MongoDB native driver is one implementation behind it (ADR-012), the
 * in-memory double another. Repositories deal in domain aggregates, never
 * driver documents or DTOs. The `(newsletterId, email)` compound uniqueness (ADR-011)
 * is the implementation's responsibility, surfaced via `findByNewsletterAndEmail`.
 */
export interface SubscriptionRepository {
  create(subscription: Subscription): Promise<void>;
  update(subscription: Subscription): Promise<void>;
  findById(id: string): Promise<Subscription | null>;
  /** The one membership for an address in a newsletter, or `null` (the compound key). */
  findByNewsletterAndEmail(newsletterId: string, email: string): Promise<Subscription | null>;
  /** Subscriptions in a newsletter, id-ordered, `id > cursor`, capped at `limit`. */
  list(options: ListSubscriptionsOptions): Promise<Subscription[]>;
  /**
   * Resolve the send targets for a newsletter: **only `subscribed`** rows,
   * narrowed by the query-time `segment`, projected to `{ address, mergeModel }`.
   * This is the seam `campaigns` calls to build a recipient set.
   */
  resolveRecipients(
    newsletterId: string,
    segment?: SubscriptionSegment,
  ): Promise<RecipientProjection[]>;
}
