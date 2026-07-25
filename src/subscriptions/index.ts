// Facade for the subscriptions component (ADR-002/005): import only from here.
// Everything below is the component's public surface; internals are reached
// only through these exports.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { subscriptionModule } from './infrastructure/module.js';
export { SUBSCRIPTION_TYPES } from './types.js';

// HTTP router (mounted under /v1/newsletters by the app assembly).
export { createSubscriptionRoutes } from './presentation/routes.js';
// Public, open unsubscribe router (mounted at /v1/unsubscribe, ADR-015) + the
// shared path constant the send path builds its List-Unsubscribe URL from.
export {
  createPublicUnsubscribeRoutes,
  PUBLIC_UNSUBSCRIBE_PATH,
} from './presentation/public-unsubscribe-routes.js';

// In-memory repository: the DI-rebind test double (ADR-003).
export { InMemorySubscriptionRepository } from './infrastructure/in-memory-subscription-repository.js';

// Domain + application contracts consumers may need to type against.
export {
  Subscription,
  SUBSCRIPTION_STATUSES,
  isSubscriptionStatus,
  type SubscriptionId,
  type SubscriptionStatus,
  type MergeFields,
} from './domain/subscription.js';
export {
  SubscriptionError,
  InvalidSubscriptionEmailError,
  InvalidSubscriptionError,
  SubscriptionNotFoundError,
  SubscriptionNewsletterNotFoundError,
  SubscriptionStateError,
  InvalidUnsubscribeTokenError,
} from './domain/errors.js';
export type {
  SubscriptionRepository,
  ListSubscriptionsOptions,
  RecipientProjection,
  SubscriptionSegment,
} from './application/subscription-repository.js';
export type { NewsletterDirectory, NewsletterInfo } from './application/newsletter-directory.js';
export type { SubscribeInput, ListSubscriptionsInput } from './application/dtos.js';

// Use case classes (resolved from the container by token; typed here for tests).
export { Subscribe } from './application/subscribe.js';
export { ConfirmSubscription } from './application/confirm-subscription.js';
export { Unsubscribe } from './application/unsubscribe.js';
export { PublicUnsubscribe } from './application/public-unsubscribe.js';
export { ListSubscriptions } from './application/list-subscriptions.js';
export { ResolveRecipients } from './application/resolve-recipients.js';
