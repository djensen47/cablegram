import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import { SuppressionEntry, type SuppressionReason } from '../domain/suppression.js';
import type {
  ListSuppressionsOptions,
  SuppressionRepository,
} from '../application/suppression-repository.js';

/**
 * The stored document shape (ADR-012): the normalized address itself is the
 * `_id` (a unique index for free — no separate id).
 */
interface SuppressionDoc {
  _id: string;
  reason: string;
  createdAt: Date;
}

/**
 * The Mongo-backed `SuppressionRepository` (ADR-012). The native driver stays
 * sealed inside this class: it maps documents to/from the domain aggregate and
 * never lets a driver type escape into `application/` or `domain/`. Pagination
 * is an address-ordered, exclusive-cursor sweep (`_id > cursor`) — the portable
 * subset, no skip/offset. `add` upserts on the address `_id`, which is both the
 * idempotency mechanism and the unique index (ADR-011).
 */
@injectable()
export class MongoSuppressionRepository implements SuppressionRepository {
  private readonly collection: Collection<SuppressionDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<SuppressionDoc>(COLLECTIONS.suppressions);
  }

  async add(entry: SuppressionEntry): Promise<SuppressionEntry> {
    // Idempotent: `$setOnInsert` writes the reason/timestamp only when a new
    // document is inserted; an existing row is left exactly as it was (ADR-011)
    // — a duplicate hard-bounce/complaint event must not overwrite the original.
    // `returnDocument: 'after'` gives back the stored entry either way.
    const doc = await this.collection.findOneAndUpdate(
      { _id: entry.address },
      { $setOnInsert: { reason: entry.reason, createdAt: entry.createdAt } },
      { upsert: true, returnDocument: 'after' },
    );
    // With `upsert: true` + `returnDocument: 'after'` the driver always returns
    // the document; fall back to the entry only to satisfy the null type.
    return doc === null ? entry : toDomain(doc);
  }

  async findByAddress(address: string): Promise<SuppressionEntry | null> {
    const doc = await this.collection.findOne({ _id: address });
    return doc === null ? null : toDomain(doc);
  }

  async list(options: ListSuppressionsOptions): Promise<SuppressionEntry[]> {
    const docs = await this.collection
      .find(options.cursor === undefined ? {} : { _id: { $gt: options.cursor } })
      .sort({ _id: 1 })
      .limit(options.limit)
      .toArray();
    return docs.map(toDomain);
  }

  async remove(address: string): Promise<boolean> {
    const { deletedCount } = await this.collection.deleteOne({ _id: address });
    return deletedCount > 0;
  }

  async filterSuppressed(addresses: string[]): Promise<string[]> {
    if (addresses.length === 0) return [];
    const docs = await this.collection
      .find({ _id: { $in: addresses } }, { projection: { _id: 1 } })
      .toArray();
    return docs.map((doc) => doc._id);
  }
}

function toDomain(doc: SuppressionDoc): SuppressionEntry {
  // The reason is only ever written by `add` (a closed `SuppressionReason`),
  // so a stored document's `reason` is trusted at the repository boundary —
  // same stance as sibling repositories re-hydrating value objects, not enums.
  return SuppressionEntry.reconstitute({
    address: doc._id,
    reason: doc.reason as SuppressionReason,
    createdAt: doc.createdAt,
  });
}
