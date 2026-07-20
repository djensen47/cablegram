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
  Subscribe: Symbol.for('Subscribe'),
  ConfirmSubscription: Symbol.for('ConfirmSubscription'),
  Unsubscribe: Symbol.for('Unsubscribe'),
  ListSubscriptions: Symbol.for('ListSubscriptions'),
  ResolveRecipients: Symbol.for('ResolveRecipients'),
} as const;
