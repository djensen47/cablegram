import type { CollectionIndexes } from '../../shared/persistence/index.js';

/** The collections `subscriptions` owns, and their indexes (ADR-017). */
export const SUBSCRIPTION_COLLECTIONS = {
  subscriptions: 'subscription_subscriptions',
} as const;

export const subscriptionIndexes: CollectionIndexes[] = [
  {
    collection: SUBSCRIPTION_COLLECTIONS.subscriptions,
    indexes: [
      // The membership key (ADR-011): unique within a newsletter, which both
      // enforces one subscription per address per newsletter and lets a
      // duplicate `create` be rejected by the store rather than a read-then-write.
      { key: { newsletterId: 1, email: 1 }, unique: true },
      // Listing + recipient resolution scan by newsletter.
      { key: { newsletterId: 1 } },
    ],
  },
];
