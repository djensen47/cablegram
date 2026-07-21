import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import { SendRecord, type RecipientOutcome, type SendRecordId } from '../domain/send-record.js';
import type { SendRecordRepository } from '../application/send-record-repository.js';

/**
 * The stored document shape (ADR-012): the campaign's `sendId` is the `_id`;
 * `campaignId` is a plain id reference; `outcomes` is a nested BSON array (an
 * opaque per-recipient ledger, read/written whole — no store-specific nested
 * queries) and `appliedEvents` a scalar array of webhook dedupe keys.
 */
interface SendRecordDoc {
  _id: string;
  campaignId: string;
  bulkRequestId: string | null;
  submittedAt: Date | null;
  outcomes: RecipientOutcome[];
  appliedEvents: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `SendRecordRepository` (ADR-012). The native driver stays
 * sealed inside this class: it maps documents to/from the domain aggregate and
 * never lets a driver type escape into `application/` or `domain/`. `outcomes`
 * is stored as an opaque array read/written whole — the portable subset, no
 * store-specific nested-document queries; `appliedEvents` is a scalar array.
 */
@injectable()
export class MongoSendRecordRepository implements SendRecordRepository {
  private readonly collection: Collection<SendRecordDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<SendRecordDoc>(COLLECTIONS.sendRecords);
  }

  async create(record: SendRecord): Promise<void> {
    await this.collection.insertOne(toDoc(record));
  }

  async update(record: SendRecord): Promise<void> {
    await this.collection.replaceOne({ _id: record.id }, toDoc(record));
  }

  async findById(id: SendRecordId): Promise<SendRecord | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }
}

function toDoc(record: SendRecord): SendRecordDoc {
  return {
    _id: record.id,
    campaignId: record.campaignId,
    bulkRequestId: record.bulkRequestId,
    submittedAt: record.submittedAt,
    outcomes: [...record.outcomes],
    appliedEvents: [...record.appliedEvents],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toDomain(doc: SendRecordDoc): SendRecord {
  return SendRecord.reconstitute({
    id: doc._id,
    campaignId: doc.campaignId,
    bulkRequestId: doc.bulkRequestId,
    submittedAt: doc.submittedAt,
    outcomes: doc.outcomes,
    appliedEvents: doc.appliedEvents,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
