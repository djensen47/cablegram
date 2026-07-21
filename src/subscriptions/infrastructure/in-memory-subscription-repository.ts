import { injectable } from 'inversify';
import type { Subscription } from '../domain/subscription.js';
import type {
  ListSubscriptionsOptions,
  RecipientProjection,
  SubscriptionRepository,
  SubscriptionSegment,
} from '../application/subscription-repository.js';

/**
 * A real in-memory `SubscriptionRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). It mirrors the Mongo repository's contract exactly: id
 * ordering, exclusive cursor, `limit` cap, `(newsletterId, email)` compound
 * uniqueness on `create`, status/tag query filters and the subscribed-only
 * recipient projection — so use-case and route tests exercise the same behavior
 * the Mongo-backed repository must honor.
 */
@injectable()
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly store = new Map<string, Subscription>();

  async create(subscription: Subscription): Promise<void> {
    const clash = this.byKey(subscription.newsletterId, subscription.email);
    if (clash !== null && clash.id !== subscription.id) {
      // The compound unique index (newsletterId, email) — surfaced as the same
      // kind of failure a Mongo duplicate-key error would raise.
      throw new Error(
        `Duplicate subscription for (${subscription.newsletterId}, ${subscription.email})`,
      );
    }
    this.store.set(subscription.id, subscription);
  }

  async update(subscription: Subscription): Promise<void> {
    this.store.set(subscription.id, subscription);
  }

  async findById(id: string): Promise<Subscription | null> {
    return this.store.get(id) ?? null;
  }

  async findByNewsletterAndEmail(
    newsletterId: string,
    email: string,
  ): Promise<Subscription | null> {
    return this.byKey(newsletterId, email);
  }

  async list(options: ListSubscriptionsOptions): Promise<Subscription[]> {
    const ordered = [...this.store.values()]
      .filter((s) => s.newsletterId === options.newsletterId)
      .filter((s) => options.status === undefined || s.status === options.status)
      .filter((s) => options.tag === undefined || s.tags.includes(options.tag))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = options.cursor;
    const filtered = after === undefined ? ordered : ordered.filter((s) => s.id > after);
    return filtered.slice(0, options.limit);
  }

  async resolveRecipients(
    newsletterId: string,
    segment?: SubscriptionSegment,
  ): Promise<RecipientProjection[]> {
    const wantedTags = segment?.tags ?? [];
    return [...this.store.values()]
      .filter((s) => s.newsletterId === newsletterId && s.status === 'subscribed')
      .filter((s) => wantedTags.every((tag) => s.tags.includes(tag)))
      .map((s) => ({ address: s.email, mergeModel: s.mergeFields }));
  }

  private byKey(newsletterId: string, email: string): Subscription | null {
    for (const s of this.store.values()) {
      if (s.newsletterId === newsletterId && s.email === email) return s;
    }
    return null;
  }
}
