import { inject, injectable } from 'inversify';
import type { Prisma, PrismaClient, Subscription as SubscriptionRow } from '@prisma/client';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
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
 * The Mongo-backed `SubscriptionRepository` (ADR-007). Prisma stays sealed
 * inside this class: it maps rows to/from the domain aggregate and never lets a
 * Prisma type escape into `application/` or `domain/`. Pagination is an
 * id-ordered, exclusive-cursor sweep (`id > cursor`) — the portable subset, no
 * skip/offset. The `(newsletterId, email)` compound unique index (ADR-011) is
 * both the membership key and the guard `findByNewsletterAndEmail` reads.
 *
 * Unverified against a live Mongo until the deployment chunk (per the build
 * plan); the in-memory repository is the tested contract meanwhile.
 */
@injectable()
export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(@inject(SHARED_TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async create(subscription: Subscription): Promise<void> {
    await this.prisma.subscription.create({ data: toRow(subscription) });
  }

  async update(subscription: Subscription): Promise<void> {
    const { id, ...data } = toRow(subscription);
    await this.prisma.subscription.update({ where: { id }, data });
  }

  async findById(id: string): Promise<Subscription | null> {
    const row = await this.prisma.subscription.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByNewsletterAndEmail(
    newsletterId: string,
    email: string,
  ): Promise<Subscription | null> {
    const row = await this.prisma.subscription.findUnique({
      where: { newsletterId_email: { newsletterId, email } },
    });
    return row === null ? null : toDomain(row);
  }

  async list(options: ListSubscriptionsOptions): Promise<Subscription[]> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        newsletterId: options.newsletterId,
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.tag === undefined ? {} : { tags: { has: options.tag } }),
        ...(options.cursor === undefined ? {} : { id: { gt: options.cursor } }),
      },
      orderBy: { id: 'asc' },
      take: options.limit,
    });
    return rows.map(toDomain);
  }

  async resolveRecipients(
    newsletterId: string,
    segment?: SubscriptionSegment,
  ): Promise<RecipientProjection[]> {
    const tags = segment?.tags ?? [];
    const rows = await this.prisma.subscription.findMany({
      where: {
        newsletterId,
        status: 'subscribed',
        ...(tags.length === 0 ? {} : { tags: { hasEvery: [...tags] } }),
      },
      select: { email: true, mergeFields: true },
    });
    return rows.map((row) => ({
      address: row.email,
      mergeModel: fromJson(row.mergeFields),
    }));
  }
}

// The write shape: identical to `SubscriptionRow` except `mergeFields` is the
// input JSON type (a stored row's `mergeFields` may be `null`; a written one
// never is — the aggregate always holds an object).
type SubscriptionWriteData = Omit<SubscriptionRow, 'mergeFields'> & {
  mergeFields: Prisma.InputJsonValue;
};

function toRow(subscription: Subscription): SubscriptionWriteData {
  return {
    id: subscription.id,
    newsletterId: subscription.newsletterId,
    email: subscription.email,
    status: subscription.status,
    mergeFields: subscription.mergeFields as Prisma.InputJsonValue,
    tags: [...subscription.tags],
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function toDomain(row: SubscriptionRow): Subscription {
  // `status` is only ever written from the closed `SubscriptionStatus` set, so
  // a stored row's value is trusted at the repository boundary (same stance as
  // sibling repositories re-hydrating value objects, not re-validating enums).
  return Subscription.reconstitute({
    id: row.id,
    newsletterId: row.newsletterId,
    email: row.email,
    status: row.status as SubscriptionStatus,
    mergeFields: fromJson(row.mergeFields),
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// Merge fields are stored as a JSON object; hydrate to the opaque merge model.
function fromJson(value: Prisma.JsonValue): MergeFields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as MergeFields)
    : {};
}
