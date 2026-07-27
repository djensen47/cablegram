/**
 * DI tokens for the deliverability component (ADR-003). A pure-Symbol leaf
 * that every layer of this component may import; the concrete bindings live
 * in the `ContainerModule` (infrastructure), and tests rebind
 * `SuppressionRepository` to an in-memory double.
 */
export const DELIVERABILITY_TYPES = {
  SuppressionRepository: Symbol.for('SuppressionRepository'),
  AddSuppression: Symbol.for('AddSuppression'),
  /** Bulk form of `AddSuppression`, for the subscriber import (ADR-022). */
  AddSuppressions: Symbol.for('AddSuppressions'),
  RemoveSuppression: Symbol.for('RemoveSuppression'),
  ListSuppressions: Symbol.for('ListSuppressions'),
  CheckSuppression: Symbol.for('CheckSuppression'),
  FilterSuppressed: Symbol.for('FilterSuppressed'),
} as const;
