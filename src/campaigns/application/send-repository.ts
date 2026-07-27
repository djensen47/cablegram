import type { Send, SendId } from '../domain/send.js';

/**
 * Persistence gateway for sends. Lives in `application/` next to its consumers
 * (ADR-001) — the MongoDB native driver is one implementation behind it
 * (ADR-012), the in-memory double another.
 *
 * One small document per campaign send, written exactly twice (opened, then
 * acknowledged). Per-recipient state is a separate collection behind
 * `RecipientOutcomeRepository` (ADR-019).
 */
export interface SendRepository {
  create(send: Send): Promise<void>;
  update(send: Send): Promise<void>;
  findById(id: SendId): Promise<Send | null>;
}
