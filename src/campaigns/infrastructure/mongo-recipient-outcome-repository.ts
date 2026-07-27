import { inject, injectable } from 'inversify';
import type { Collection, Db, Filter, UpdateFilter } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';
import { zeroStats, type CampaignStats } from '../domain/campaign.js';
import {
  RecipientOutcome,
  priorityOf,
  type OutcomeStatus,
} from '../domain/recipient-outcome.js';
import type {
  ApplyOutcomeEvent,
  ListOutcomesOptions,
  RecipientOutcomeRepository,
} from '../application/recipient-outcome-repository.js';

/**
 * The stored document (ADR-012, ADR-019): one per recipient per send, app-owned
 * string `_id`, id-reference relations only. `statusPriority` is persisted
 * beside the label because the conditional update filters on it.
 */
interface OutcomeDoc {
  _id: string;
  sendId: string;
  campaignId: string;
  address: string;
  messageId: string | null;
  status: OutcomeStatus;
  statusPriority: number;
  opens: number;
  clicks: number;
  applied: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `RecipientOutcomeRepository` (ADR-019) — the collection this
 * whole redesign exists for.
 *
 * The old implementation loaded a multi-megabyte send record, mutated an
 * embedded array, and `replaceOne`'d the whole document, once per webhook. With
 * ~50k webhooks per send that was ~560 GB of I/O, an O(n²) dedupe scan, a hard
 * 16 MB BSON ceiling around 100k recipients, and — worst — **silent lost
 * updates**, because concurrent webhooks each wrote back a whole document built
 * from a stale read.
 *
 * Every write here is instead a single targeted update to a single document.
 * No read, no whole-document rewrite, and no lost updates: MongoDB guarantees
 * atomicity per document, which is exactly the guarantee ADR-012 already relies
 * on ("every write is a single document, nothing uses transactions").
 */
@injectable()
export class MongoRecipientOutcomeRepository implements RecipientOutcomeRepository {
  private readonly collection: Collection<OutcomeDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<OutcomeDoc>(CAMPAIGN_COLLECTIONS.recipientOutcomes);
  }

  async createMany(outcomes: readonly RecipientOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    // `ordered: false` so one duplicate address cannot abort the rest of the
    // batch — the unique (sendId, address) index is the guard, and re-opening a
    // send should not lose 17,999 rows because one collided.
    await this.collection.insertMany(outcomes.map(toDoc), { ordered: false });
  }

  async markAccepted(sendId: string, now: Date): Promise<void> {
    // One bulk update, not a loop: the broadcast was handed to the provider, so
    // every recipient still sitting at `pending` becomes `accepted`.
    await this.collection.updateMany(
      { sendId, status: 'pending' },
      { $set: { status: 'accepted', statusPriority: priorityOf('accepted'), updatedAt: now } },
    );
  }

  /**
   * The hot path — one atomic, idempotent, single-document update per webhook.
   *
   * Two guards, both expressed in the *filter* so the store evaluates them
   * rather than the application reading first:
   *
   *  - `applied: { $ne: key }` makes a replayed webhook a no-op. Postmark
   *    retries for hours on any non-200, so duplicates are routine, not rare.
   *  - `statusPriority: { $lt: n }` enforces "only ever raise". A `delivered`
   *    arriving after a `bounced` matches nothing and changes nothing, so
   *    out-of-order delivery converges instead of flapping.
   *
   * A plain conditional update rather than `$max` or an aggregation pipeline:
   * `WHERE statusPriority < n` is expressible in any store, keeping ADR-012's
   * portable subset intact.
   */
  async applyEvent(event: ApplyOutcomeEvent): Promise<boolean> {
    const { sendId, address, effect, dedupeKey, now } = event;
    if (effect.kind === 'ignore') return false;

    const filter: Filter<OutcomeDoc> = { sendId, address };
    if (dedupeKey !== null) filter.applied = { $ne: dedupeKey };

    const set: Partial<OutcomeDoc> = { updatedAt: now };
    const update: UpdateFilter<OutcomeDoc> = {};

    if (effect.kind === 'raise') {
      const priority = priorityOf(effect.status);
      filter.statusPriority = { $lt: priority };
      set.status = effect.status;
      set.statusPriority = priority;
    } else {
      update.$inc = { [effect.field]: 1 };
    }

    update.$set = set;
    if (dedupeKey !== null) update.$addToSet = { applied: dedupeKey };

    const result = await this.collection.updateOne(filter, update);
    return result.modifiedCount > 0;
  }

  /**
   * Aggregate stats for a send, counted from the outcomes themselves.
   *
   * Computed on read rather than maintained as counters: a counter has to be
   * incremented on a *transition* (pending→delivered is −1/+1), which is not
   * derivable from a single atomic update and drifts permanently once wrong.
   * This is one grouped count over an indexed `sendId`, and it runs when
   * someone reads a report — not on every one of ~50k webhooks, which is what
   * the previous design did.
   */
  async stats(sendId: string): Promise<CampaignStats> {
    const rows = await this.collection
      .aggregate<{ _id: OutcomeStatus; count: number }>([
        { $match: { sendId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();

    const byStatus = new Map(rows.map((r) => [r._id, r.count]));
    const count = (status: OutcomeStatus): number => byStatus.get(status) ?? 0;

    const stats = zeroStats();
    for (const [, n] of byStatus) stats.recipients += n;
    stats.rejected = count('rejected');
    stats.delivered = count('delivered');
    stats.bounced = count('bounced');
    stats.complained = count('complained');
    // "Accepted" means the provider took it — everything that got past
    // `pending` without being rejected, including those since delivered or
    // bounced. Matches the previous aggregate's meaning.
    stats.accepted = stats.recipients - stats.rejected - count('pending');
    return stats;
  }

  async list(options: ListOutcomesOptions): Promise<RecipientOutcome[]> {
    const filter: Filter<OutcomeDoc> = { sendId: options.sendId };
    if (options.statuses !== undefined && options.statuses.length > 0) {
      filter.status = { $in: [...options.statuses] };
    }
    if (options.cursor !== undefined) filter._id = { $gt: options.cursor };

    const docs = await this.collection
      .find(filter)
      .sort({ _id: 1 })
      .limit(options.limit)
      .toArray();
    return docs.map(toDomain);
  }
}

function toDoc(outcome: RecipientOutcome): OutcomeDoc {
  return {
    _id: outcome.id,
    sendId: outcome.sendId,
    campaignId: outcome.campaignId,
    address: outcome.address,
    messageId: outcome.messageId,
    status: outcome.status,
    statusPriority: priorityOf(outcome.status),
    opens: outcome.opens,
    clicks: outcome.clicks,
    applied: [],
    createdAt: outcome.createdAt,
    updatedAt: outcome.updatedAt,
  };
}

function toDomain(doc: OutcomeDoc): RecipientOutcome {
  return RecipientOutcome.reconstitute({
    id: doc._id,
    sendId: doc.sendId,
    campaignId: doc.campaignId,
    address: doc.address,
    messageId: doc.messageId,
    status: doc.status,
    statusPriority: doc.statusPriority,
    opens: doc.opens,
    clicks: doc.clicks,
    applied: doc.applied,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
