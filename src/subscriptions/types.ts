/**
 * DI tokens for the subscriptions component (ADR-003). A pure-Symbol leaf that
 * every layer of this component may import; the concrete bindings live in the
 * `ContainerModule` (infrastructure). Tests rebind `SubscriptionRepository` to
 * an in-memory double and `email`'s `DeliveryGateway` to its in-memory double.
 */
export const SUBSCRIPTION_TYPES = {
  SubscriptionRepository: Symbol.for('SubscriptionRepository'),
  /** Consumer-owned port over the `newsletters` facade (target existence + sender identity). */
  NewsletterDirectory: Symbol.for('SubscriptionsNewsletterDirectory'),
  /**
   * Consumer-owned port over the `deliverability` facade — the global list, for
   * imported hard bounces only (ADR-022). Complaints never reach it (ADR-018).
   */
  SuppressionGateway: Symbol.for('SubscriptionsSuppressionGateway'),
  Subscribe: Symbol.for('Subscribe'),
  /** Restore memberships from another ESP, statuses verbatim, no mail (ADR-022). */
  ImportSubscriptions: Symbol.for('ImportSubscriptions'),
  ConfirmSubscription: Symbol.for('ConfirmSubscription'),
  Unsubscribe: Symbol.for('Unsubscribe'),
  /** Address-keyed status change for provider-driven bounces/complaints (ADR-018). */
  MarkSubscriptionOutcome: Symbol.for('MarkSubscriptionOutcome'),
  /** Public, token-authenticated unsubscribe (ADR-015); no JWT. */
  PublicUnsubscribe: Symbol.for('PublicUnsubscribe'),
  ListSubscriptions: Symbol.for('ListSubscriptions'),
  ResolveRecipients: Symbol.for('ResolveRecipients'),
} as const;
