/**
 * DI tokens (ADR-003). Shared-kernel tokens live here; each domain component
 * exports its own `TYPES` that the composition root merges in as it's added.
 */
export const TYPES = {
  Config: Symbol.for('Config'),
  Clock: Symbol.for('Clock'),
} as const;
