import { inject, injectable } from 'inversify';
import type { Collection, Db, Filter } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import {
  Subscription,
  type MergeFields,
  type SubscriptionStatus,
} from '../domain/subscription.js';
import type {
  ListSubscriptionsOptions,
  RecipientProjection,
  SubscriptionRepository,
  SubscriptionSegment,
} from '../application/subscription-repository.js';

/**
 * The stored document shape (ADR-012): the app string id is the `_id`;
 * `newsletterId` is a plain id reference (no embedded document); `mergeFields`
 * is a nested BSON object (an opaque scalar bag) and `tags` a scalar array.
 */
interface SubscriptionDoc {
  _id: string;
  newsletterId: string;
  email: string;
  status: string;
  mergeFields: MergeFields;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `SubscriptionRepository` (ADR-012). The native driver stays
 * sealed inside this class: it maps documents to/from the domain aggregate and
 * never lets a driver type escape into `application/` or `domain/`. Pagination
 * is an id-ordered, exclusive-cursor sweep (`_id > cursor`) — the portable
 * subset, no skip/offset. The `(newsletterId, email)` compound unique index
 * (ADR-011) is both the membership key and the guard `findByNewsletterAndEmail`
 * reads; a duplicate `create` is rejected by that index.
 */
@injectable()
export class MongoSubscriptionRepository implements SubscriptionRepository {
  private readonly collection: Collection<SubscriptionDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<SubscriptionDoc>(COLLECTIONS.subscriptions);
  }

  async create(subscription: Subscription): Promise<void> {
    await this.collection.insertOne(toDoc(subscription));
  }

  async update(subscription: Subscription): Promise<void> {
    await this.collection.replaceOne({ _id: subscription.id }, toDoc(subscription));
  }

  async findById(id: string): Promise<Subscription | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }

  async findByNewsletterAndEmail(
    newsletterId: string,
    email: string,
  ): Promise<Subscription | null> {
    const doc = await this.collection.findOne({ newsletterId, email });
    return doc === null ? null : toDomain(doc);
  }

  async list(options: ListSubscriptionsOptions): Promise<Subscription[]> {
    const filter: Filter<SubscriptionDoc> = {
      newsletterId: options.newsletterId,
      ...(options.status === undefined ? {} : { status: options.status }),
      // A scalar-array equality match selects documents whose `tags` contains
      // the value (Mongo array-contains semantics) — the `has` equivalent.
      ...(options.tag === undefined ? {} : { tags: options.tag }),
      ...(options.cursor === undefined ? {} : { _id: { $gt: options.cursor } }),
    };
    const docs = await this.collection.find(filter).sort({ _id: 1 }).limit(options.limit).toArray();
    return docs.map(toDomain);
  }

  async resolveRecipients(
    newsletterId: string,
    segment?: SubscriptionSegment,
  ): Promise<RecipientProjection[]> {
    const tags = segment?.tags ?? [];
    const filter: Filter<SubscriptionDoc> = {
      newsletterId,
      status: 'subscribed',
      // AND-match every requested tag (`$all` is the `hasEvery` equivalent).
      ...(tags.length === 0 ? {} : { tags: { $all: [...tags] } }),
    };
    const docs = await this.collection
      .find(filter, { projection: { _id: 1, email: 1, mergeFields: 1 } })
      .toArray();
    return docs.map((doc) => ({
      subscriptionId: doc._id,
      address: doc.email,
      mergeModel: fromStored(doc.mergeFields),
    }));
  }
}

function toDoc(subscription: Subscription): SubscriptionDoc {
  return {
    _id: subscription.id,
    newsletterId: subscription.newsletterId,
    email: subscription.email,
    status: subscription.status,
    mergeFields: subscription.mergeFields,
    tags: [...subscription.tags],
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function toDomain(doc: SubscriptionDoc): Subscription {
  // `status` is only ever written from the closed `SubscriptionStatus` set, so
  // a stored document's value is trusted at the repository boundary (same
  // stance as sibling repositories re-hydrating value objects, not enums).
  return Subscription.reconstitute({
    id: doc._id,
    newsletterId: doc.newsletterId,
    email: doc.email,
    status: doc.status as SubscriptionStatus,
    mergeFields: fromStored(doc.mergeFields),
    tags: doc.tags,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

// Merge fields are stored as a JSON object; hydrate to the opaque merge model,
// defaulting anything unexpected (null / array) to an empty model.
function fromStored(value: unknown): MergeFields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as MergeFields)
    : {};
}
