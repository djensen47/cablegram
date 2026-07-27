import type { CollectionIndexes } from './shared/persistence/index.js';
import { accountIndexes } from './accounts/index.js';
import { newsletterIndexes } from './newsletters/index.js';
import { subscriptionIndexes } from './subscriptions/index.js';
import { deliverabilityIndexes } from './deliverability/index.js';
import { templateIndexes } from './templates/index.js';
import { campaignIndexes } from './campaigns/index.js';

/**
 * Every collection the application owns, assembled from the components that own
 * them (ADR-017).
 *
 * This is app-level assembly, deliberately explicit and in the same spirit as
 * `app.ts` mounting each component's router: the composition is visible in one
 * place, but the *content* — collection names, index keys — belongs to each
 * component and is declared there. What this file must never become again is
 * the previous `shared/persistence/collections.ts`, which held the schema
 * knowledge of six domain contexts inside a `shared/*` leaf.
 *
 * Adding a component means adding one line here. `indexes.test.ts` asserts the
 * registry is complete and unambiguous so a forgotten line cannot ship a
 * silently unindexed collection.
 */
export const ALL_INDEXES: readonly CollectionIndexes[] = [
  ...accountIndexes,
  ...newsletterIndexes,
  ...subscriptionIndexes,
  ...deliverabilityIndexes,
  ...templateIndexes,
  ...campaignIndexes,
];
