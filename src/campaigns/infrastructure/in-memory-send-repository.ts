import { injectable } from 'inversify';
import { Send, type SendId } from '../domain/send.js';
import type { SendRepository } from '../application/send-repository.js';

/**
 * A real in-memory `SendRepository` (not a mock) — the DI-rebind test seam
 * (ADR-003). One record per send, keyed by `sendId`.
 *
 * It copies on the way in and on the way out, as a driver does. Storing the
 * caller's own object meant a change made in memory was "stored" even when the
 * write that should have stored it failed — which is the case ADR-035 has to
 * get right: an acknowledgment that never reached the store.
 */
@injectable()
export class InMemorySendRepository implements SendRepository {
  private readonly store = new Map<string, Send>();

  async create(send: Send): Promise<void> {
    this.store.set(send.id, copyOf(send));
  }

  async update(send: Send): Promise<void> {
    this.store.set(send.id, copyOf(send));
  }

  async findById(id: SendId): Promise<Send | null> {
    const stored = this.store.get(id);
    return stored === undefined ? null : copyOf(stored);
  }
}

/** A detached copy — what a stored document turns into on its way through a driver. */
function copyOf(send: Send): Send {
  return Send.reconstitute({
    id: send.id,
    campaignId: send.campaignId,
    bulkRequestId: send.bulkRequestId,
    submittedAt: send.submittedAt,
    recipientCount: send.recipientCount,
    createdAt: send.createdAt,
    updatedAt: send.updatedAt,
  });
}
