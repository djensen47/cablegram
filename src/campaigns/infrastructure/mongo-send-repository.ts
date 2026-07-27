import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';
import { Send, type SendId } from '../domain/send.js';
import type { SendRepository } from '../application/send-repository.js';

/**
 * The stored document (ADR-012): the campaign's `sendId` is the `_id`,
 * `campaignId` a plain id reference. Small and bounded — the per-recipient
 * ledger that used to live here as an embedded array is now its own collection
 * (ADR-019).
 */
interface SendDoc {
  _id: string;
  campaignId: string;
  bulkRequestId: string | null;
  submittedAt: Date | null;
  recipientCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `SendRepository` (ADR-012). The native driver stays sealed
 * inside this class: it maps documents to/from the domain aggregate and never
 * lets a driver type escape into `application/` or `domain/`.
 *
 * `replaceOne` is safe here in a way it was not on the old send record: this
 * document is written exactly twice, by the send path, never concurrently by
 * webhooks.
 */
@injectable()
export class MongoSendRepository implements SendRepository {
  private readonly collection: Collection<SendDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<SendDoc>(CAMPAIGN_COLLECTIONS.sends);
  }

  async create(send: Send): Promise<void> {
    await this.collection.insertOne(toDoc(send));
  }

  async update(send: Send): Promise<void> {
    await this.collection.replaceOne({ _id: send.id }, toDoc(send));
  }

  async findById(id: SendId): Promise<Send | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }
}

function toDoc(send: Send): SendDoc {
  return {
    _id: send.id,
    campaignId: send.campaignId,
    bulkRequestId: send.bulkRequestId,
    submittedAt: send.submittedAt,
    recipientCount: send.recipientCount,
    createdAt: send.createdAt,
    updatedAt: send.updatedAt,
  };
}

function toDomain(doc: SendDoc): Send {
  return Send.reconstitute({
    id: doc._id,
    campaignId: doc.campaignId,
    bulkRequestId: doc.bulkRequestId,
    submittedAt: doc.submittedAt,
    recipientCount: doc.recipientCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
