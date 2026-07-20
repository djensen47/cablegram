import { injectable } from 'inversify';
import type { SendRecord, SendRecordId } from '../domain/send-record.js';
import type { SendRecordRepository } from '../application/send-record-repository.js';

/**
 * A real in-memory `SendRecordRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). One record per send, keyed by `sendId`; mirrors the Prisma
 * repository's read/write-whole contract so use-case and webhook tests exercise
 * the same behavior the Mongo-backed repository must honor.
 */
@injectable()
export class InMemorySendRecordRepository implements SendRecordRepository {
  private readonly store = new Map<string, SendRecord>();

  async create(record: SendRecord): Promise<void> {
    this.store.set(record.id, record);
  }

  async update(record: SendRecord): Promise<void> {
    this.store.set(record.id, record);
  }

  async findById(id: SendRecordId): Promise<SendRecord | null> {
    return this.store.get(id) ?? null;
  }
}
