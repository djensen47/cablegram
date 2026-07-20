import type { SendRecord, SendRecordId } from '../domain/send-record.js';

/**
 * Persistence gateway for send records. Lives in `application/` next to its
 * consumers (ADR-001) — Prisma is one implementation behind it (ADR-007), the
 * in-memory double another. One record per campaign send, keyed by the
 * campaign's `sendId`; per-recipient outcomes are read and written as a whole
 * (ADR-007 portable subset — no store-specific nested-document queries).
 */
export interface SendRecordRepository {
  create(record: SendRecord): Promise<void>;
  update(record: SendRecord): Promise<void>;
  findById(id: SendRecordId): Promise<SendRecord | null>;
}
