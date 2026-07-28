import { inject, injectable } from 'inversify';
import type { Collection, Db, Filter } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { SUBSCRIPTION_COLLECTIONS } from './collections.js';
import {
  Subscription,
  type CustomFields,
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
 * `newsletterId` is a plain id reference (no embedded document); `customFields`
 * is a nested BSON object (an opaque scalar bag) and `tags` a scalar array.
 */
interface SubscriptionDoc {
  _id: string;
  newsletterId: string;
  email: string;
  status: string;
  customFields: CustomFields;
  tags: string[];
  consecutiveSoftBounces?: number;
  /** Absent on natively-collected rows (ADR-022) — not every row has a source. */
  source?: string;
  // The consent record (ADR-023). All optional: a row may have signed up
  // without observed evidence, may never have confirmed, and may never have
  // opted out.
  signupIp?: string;
  signupUserAgent?: string;
  confirmedAt?: Date;
  confirmedIp?: string;
  confirmedUserAgent?: string;
  unsubscribedAt?: Date;
  unsubscribedIp?: string;
  unsubscribedUserAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Optional scalars are omitted rather than written as null: absence is the
// statement ("we never observed this"), and a document full of nulls says the
// same thing less clearly while costing more to store 18k times over.
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
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
    this.collection = db.collection<SubscriptionDoc>(SUBSCRIPTION_COLLECTIONS.subscriptions);
  }

  async create(subscription: Subscription): Promise<void> {
    await this.collection.insertOne(toDoc(subscription));
  }

  async update(subscription: Subscription): Promise<void> {
    await this.collection.replaceOne({ _id: subscription.id }, toDoc(subscription));
  }

  async saveMany(subscriptions: readonly Subscription[]): Promise<void> {
    if (subscriptions.length === 0) return;
    // A batch of independent single-document replaces — NOT a transaction
    // (ADR-012: nothing here needs a replica set). `ordered: false` lets the
    // whole batch attempt even if one document fails, and upserting by `_id` is
    // safe because the caller resolved existing ids by `(newsletterId, email)`
    // first: a new row carries a fresh id, an overwrite carries the stored one.
    await this.collection.bulkWrite(
      subscriptions.map((subscription) => ({
        replaceOne: {
          filter: { _id: subscription.id },
          replacement: toDoc(subscription),
          upsert: true,
        },
      })),
      { ordered: false },
    );
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

  async findByNewsletterAndEmails(
    newsletterId: string,
    emails: readonly string[],
  ): Promise<Subscription[]> {
    if (emails.length === 0) return [];
    // Served by the `(newsletterId, email)` unique index — the same key the
    // single-address lookup uses, so one batched read replaces N point reads.
    const docs = await this.collection
      .find({ newsletterId, email: { $in: [...emails] } })
      .toArray();
    return docs.map(toDomain);
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
      .find(filter, { projection: { _id: 1, email: 1, customFields: 1 } })
      .toArray();
    return docs.map((doc) => ({
      subscriptionId: doc._id,
      address: doc.email,
      customFields: fromStored(doc.customFields),
    }));
  }
}

function toDoc(subscription: Subscription): SubscriptionDoc {
  return {
    _id: subscription.id,
    newsletterId: subscription.newsletterId,
    email: subscription.email,
    status: subscription.status,
    customFields: subscription.customFields,
    tags: [...subscription.tags],
    consecutiveSoftBounces: subscription.consecutiveSoftBounces,
    ...defined({
      source: subscription.source,
      signupIp: subscription.signupIp,
      signupUserAgent: subscription.signupUserAgent,
      confirmedAt: subscription.confirmedAt,
      confirmedIp: subscription.confirmedIp,
      confirmedUserAgent: subscription.confirmedUserAgent,
      unsubscribedAt: subscription.unsubscribedAt,
      unsubscribedIp: subscription.unsubscribedIp,
      unsubscribedUserAgent: subscription.unsubscribedUserAgent,
    }),
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
    customFields: fromStored(doc.customFields),
    // Absent on rows written before the counter existed — treat as no streak.
    tags: doc.tags,
    consecutiveSoftBounces: doc.consecutiveSoftBounces ?? 0,
    source: doc.source,
    signupIp: doc.signupIp,
    signupUserAgent: doc.signupUserAgent,
    confirmedAt: doc.confirmedAt,
    confirmedIp: doc.confirmedIp,
    confirmedUserAgent: doc.confirmedUserAgent,
    unsubscribedAt: doc.unsubscribedAt,
    unsubscribedIp: doc.unsubscribedIp,
    unsubscribedUserAgent: doc.unsubscribedUserAgent,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

// Custom fields are stored as a JSON object; hydrate to the opaque custom-field model,
// defaulting anything unexpected (null / array) to an empty model.
function fromStored(value: unknown): CustomFields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as CustomFields)
    : {};
}
