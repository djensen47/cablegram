import { ContainerModule } from 'inversify';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { SubscriptionRepository } from '../application/subscription-repository.js';
import type { NewsletterDirectory } from '../application/newsletter-directory.js';
import type { SuppressionGateway } from '../application/suppression-gateway.js';
import { Subscribe } from '../application/subscribe.js';
import { ImportSubscriptions } from '../application/import-subscriptions.js';
import { ConfirmSubscription } from '../application/confirm-subscription.js';
import { Unsubscribe } from '../application/unsubscribe.js';
import { MarkSubscriptionOutcome } from '../application/mark-subscription-outcome.js';
import { PublicUnsubscribe } from '../application/public-unsubscribe.js';
import { ListSubscriptions } from '../application/list-subscriptions.js';
import { ResolveRecipients } from '../application/resolve-recipients.js';
import { MongoSubscriptionRepository } from './mongo-subscription-repository.js';
import { FacadeNewsletterDirectory } from './facade-newsletter-directory.js';
import { FacadeSuppressionGateway } from './facade-suppression-gateway.js';

/**
 * The subscriptions component's DI wiring (ADR-003). Loaded by the composition
 * root; the canonical repository is Mongo-backed here, the `NewsletterDirectory`
 * port is fulfilled by the `newsletters`-facade adapter, and tests rebind
 * `SubscriptionRepository` to `InMemorySubscriptionRepository` (and `email`'s
 * `DeliveryGateway` to its in-memory double). Interfaces only are injected —
 * never a concrete class.
 */
export const subscriptionModule = new ContainerModule((bind) => {
  bind<SubscriptionRepository>(SUBSCRIPTION_TYPES.SubscriptionRepository).to(
    MongoSubscriptionRepository,
  );
  bind<NewsletterDirectory>(SUBSCRIPTION_TYPES.NewsletterDirectory).to(FacadeNewsletterDirectory);
  bind<SuppressionGateway>(SUBSCRIPTION_TYPES.SuppressionGateway).to(FacadeSuppressionGateway);

  bind<Subscribe>(SUBSCRIPTION_TYPES.Subscribe).to(Subscribe);
  bind<ImportSubscriptions>(SUBSCRIPTION_TYPES.ImportSubscriptions).to(ImportSubscriptions);
  bind<ConfirmSubscription>(SUBSCRIPTION_TYPES.ConfirmSubscription).to(ConfirmSubscription);
  bind<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe).to(Unsubscribe);
  bind<MarkSubscriptionOutcome>(SUBSCRIPTION_TYPES.MarkSubscriptionOutcome).to(
    MarkSubscriptionOutcome,
  );
  bind<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe).to(PublicUnsubscribe);
  bind<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions).to(ListSubscriptions);
  bind<ResolveRecipients>(SUBSCRIPTION_TYPES.ResolveRecipients).to(ResolveRecipients);
});
