// Facade for the deliverability component (ADR-002/005): import only from
// here. Everything below is the component's public surface; internals are
// reached only through these exports.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { deliverabilityModule } from './infrastructure/module.js';
export { DELIVERABILITY_TYPES } from './types.js';

// HTTP router (mounted onto /v1 by the app assembly).
export { createDeliverabilityRoutes } from './presentation/routes.js';

// In-memory repository: the DI-rebind test double (ADR-003).
export { InMemorySuppressionRepository } from './infrastructure/in-memory-suppression-repository.js';

// Domain + application contracts consumers may need to type against.
export {
  SuppressionEntry,
  SUPPRESSION_REASONS,
  isSuppressionReason,
  type SuppressionReason,
} from './domain/suppression.js';
export {
  DeliverabilityError,
  InvalidSuppressedAddressError,
  SuppressionNotFoundError,
} from './domain/errors.js';
export type {
  SuppressionRepository,
  ListSuppressionsOptions,
} from './application/suppression-repository.js';
export type { AddSuppressionInput, ListSuppressionsInput } from './application/dtos.js';

// Use case classes (resolved from the container by token; typed here for tests).
export { AddSuppression } from './application/add-suppression.js';
export { RemoveSuppression } from './application/remove-suppression.js';
export { ListSuppressions } from './application/list-suppressions.js';
export { CheckSuppression } from './application/check-suppression.js';
export { FilterSuppressed } from './application/filter-suppressed.js';
