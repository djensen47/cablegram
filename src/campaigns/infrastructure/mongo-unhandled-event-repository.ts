import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';
import type {
  RecordUnhandledEvent,
  UnhandledEventRecord,
  UnhandledEventRepository,
} from '../application/unhandled-event-repository.js';

/**
 * The stored document (ADR-012): the bucket key **is** the `_id`, which is what
 * makes the whole design bounded — a second payload of the same kind can only
 * ever update the row the first one created, never add to the collection.
 */
interface UnhandledEventDoc {
  _id: string;
  count: number;
  sample: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * The Mongo-backed `UnhandledEventRepository` (issue #29).
 *
 * `record` is one upsert on one document — the same discipline as the
 * per-recipient outcome writes (ADR-019): no read first, so concurrent webhooks
 * for the same key cannot lose each other's increments, and no transaction, so
 * a standalone `mongod` still suffices (ADR-012).
 */
@injectable()
export class MongoUnhandledEventRepository implements UnhandledEventRepository {
  private readonly collection: Collection<UnhandledEventDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<UnhandledEventDoc>(CAMPAIGN_COLLECTIONS.unhandledEvents);
  }

  async record(entry: RecordUnhandledEvent): Promise<void> {
    // `$setOnInsert` pins the sample to the FIRST payload seen. Keeping the
    // first rather than the latest makes the row stable: you can look at it
    // twice a week apart and reason about the same evidence.
    await this.collection.updateOne(
      { _id: entry.key },
      {
        $inc: { count: 1 },
        $set: { lastSeenAt: entry.now },
        $setOnInsert: { sample: entry.sample, firstSeenAt: entry.now },
      },
      { upsert: true },
    );
  }

  async list(): Promise<UnhandledEventRecord[]> {
    // Unbounded `find` on a deliberately bounded collection: one row per
    // distinct record type, so "everything" is a few dozen documents at worst.
    const docs = await this.collection.find({}).sort({ count: -1, _id: 1 }).toArray();
    return docs.map(toRecord);
  }
}

function toRecord(doc: UnhandledEventDoc): UnhandledEventRecord {
  return {
    key: doc._id,
    count: doc.count,
    sample: doc.sample,
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
  };
}
