import type { CollectionIndexes } from '../../shared/persistence/index.js';

/** The collections `deliverability` owns, and their indexes (ADR-017). */
export const DELIVERABILITY_COLLECTIONS = {
  suppressions: 'deliverability_suppressions',
} as const;

// No declared indexes: the suppressed **address is the `_id`**, so the
// send-path lookup (gate 2) and uniqueness both ride the implicit index.
export const deliverabilityIndexes: CollectionIndexes[] = [
  { collection: DELIVERABILITY_COLLECTIONS.suppressions, indexes: [] },
];
