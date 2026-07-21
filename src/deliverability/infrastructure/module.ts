import { ContainerModule } from 'inversify';
import { DELIVERABILITY_TYPES } from '../types.js';
import type { SuppressionRepository } from '../application/suppression-repository.js';
import { AddSuppression } from '../application/add-suppression.js';
import { RemoveSuppression } from '../application/remove-suppression.js';
import { ListSuppressions } from '../application/list-suppressions.js';
import { CheckSuppression } from '../application/check-suppression.js';
import { FilterSuppressed } from '../application/filter-suppressed.js';
import { MongoSuppressionRepository } from './mongo-suppression-repository.js';

/**
 * The deliverability component's DI wiring (ADR-003). Loaded by the
 * composition root; the canonical repository is Mongo-backed here, and tests
 * rebind `SuppressionRepository` to `InMemorySuppressionRepository`.
 * Interfaces only are injected — never a concrete class.
 */
export const deliverabilityModule = new ContainerModule((bind) => {
  bind<SuppressionRepository>(DELIVERABILITY_TYPES.SuppressionRepository).to(
    MongoSuppressionRepository,
  );

  bind<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression).to(AddSuppression);
  bind<RemoveSuppression>(DELIVERABILITY_TYPES.RemoveSuppression).to(RemoveSuppression);
  bind<ListSuppressions>(DELIVERABILITY_TYPES.ListSuppressions).to(ListSuppressions);
  bind<CheckSuppression>(DELIVERABILITY_TYPES.CheckSuppression).to(CheckSuppression);
  bind<FilterSuppressed>(DELIVERABILITY_TYPES.FilterSuppressed).to(FilterSuppressed);
});
