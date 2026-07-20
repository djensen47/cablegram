import { inject, injectable } from 'inversify';
import type { Prisma, PrismaClient, SendRecord as SendRecordRow } from '@prisma/client';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { SendRecord, type RecipientOutcome, type SendRecordId } from '../domain/send-record.js';
import type { SendRecordRepository } from '../application/send-record-repository.js';

/**
 * The Mongo-backed `SendRecordRepository` (ADR-007). Prisma stays sealed inside
 * this class: it maps rows to/from the domain aggregate and never lets a Prisma
 * type escape into `application/` or `domain/`. `outcomes` is stored as an
 * opaque JSON array read/written whole — the portable subset, no store-specific
 * nested-document queries; `appliedEvents` is a scalar list.
 *
 * Unverified against a live Mongo until the deployment chunk (per the build
 * plan); the in-memory repository is the tested contract meanwhile.
 */
@injectable()
export class PrismaSendRecordRepository implements SendRecordRepository {
  constructor(@inject(SHARED_TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async create(record: SendRecord): Promise<void> {
    await this.prisma.sendRecord.create({ data: toRow(record) });
  }

  async update(record: SendRecord): Promise<void> {
    const { id, ...data } = toRow(record);
    await this.prisma.sendRecord.update({ where: { id }, data });
  }

  async findById(id: SendRecordId): Promise<SendRecord | null> {
    const row = await this.prisma.sendRecord.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }
}

// The write shape: identical to `SendRecordRow` except `outcomes` is the input
// JSON type (the aggregate always holds an array).
type SendRecordWriteData = Omit<SendRecordRow, 'outcomes'> & {
  outcomes: Prisma.InputJsonValue;
};

function toRow(record: SendRecord): SendRecordWriteData {
  return {
    id: record.id,
    campaignId: record.campaignId,
    outcomes: record.outcomes as unknown as Prisma.InputJsonValue,
    appliedEvents: [...record.appliedEvents],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toDomain(row: SendRecordRow): SendRecord {
  return SendRecord.reconstitute({
    id: row.id,
    campaignId: row.campaignId,
    outcomes: row.outcomes as unknown as RecipientOutcome[],
    appliedEvents: row.appliedEvents,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
