import type { CollectionIndexes } from '../../shared/persistence/index.js';

/** The collections `templates` owns, and their indexes (ADR-017). */
export const TEMPLATE_COLLECTIONS = {
  templates: 'template_templates',
} as const;

// No declared indexes — templates are reached by `_id` or listed wholesale.
export const templateIndexes: CollectionIndexes[] = [
  { collection: TEMPLATE_COLLECTIONS.templates, indexes: [] },
];
