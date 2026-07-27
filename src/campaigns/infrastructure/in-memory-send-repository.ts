import { injectable } from 'inversify';
import type { Send, SendId } from '../domain/send.js';
import type { SendRepository } from '../application/send-repository.js';

/**
 * A real in-memory `SendRepository` (not a mock) — the DI-rebind test seam
 * (ADR-003). One record per send, keyed by `sendId`.
 */
@injectable()
export class InMemorySendRepository implements SendRepository {
  private readonly store = new Map<string, Send>();

  async create(send: Send): Promise<void> {
    this.store.set(send.id, send);
  }

  async update(send: Send): Promise<void> {
    this.store.set(send.id, send);
  }

  async findById(id: SendId): Promise<Send | null> {
    return this.store.get(id) ?? null;
  }
}
