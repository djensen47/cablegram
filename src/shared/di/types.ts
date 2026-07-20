/**
 * DI tokens (ADR-003). Shared-kernel tokens live here; each domain component
 * exports its own `TYPES` that the composition root merges in as it's added.
 */
export const TYPES = {
  Config: Symbol.for('Config'),
  Clock: Symbol.for('Clock'),
  /**
   * The MongoDB connection pool (`PrismaClient`), owned by the composition root
   * and shared by every component's Prisma repository (ADR-007, ADR-009 — one
   * pool at module scope). Bound lazily so tests that rebind repositories to
   * in-memory doubles never open a connection.
   */
  PrismaClient: Symbol.for('PrismaClient'),
} as const;
