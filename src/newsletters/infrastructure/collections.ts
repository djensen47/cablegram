import type { CollectionIndexes } from '../../shared/persistence/index.js';

/** The collections `newsletters` owns, and their indexes (ADR-017). */
export const NEWSLETTER_COLLECTIONS = {
  newsletters: 'newsletter_newsletters',
} as const;

// Declared with no indexes: newsletters are only ever reached by `_id` (whose
// index is implicit and free) or listed wholesale. The entry still earns its
// place — it is what makes this component's storage footprint discoverable
// from the component itself (ADR-017), rather than being invisible because it
// happens to need nothing.
export const newsletterIndexes: CollectionIndexes[] = [
  { collection: NEWSLETTER_COLLECTIONS.newsletters, indexes: [] },
];
