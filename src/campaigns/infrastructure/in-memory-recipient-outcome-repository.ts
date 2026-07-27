import { injectable } from 'inversify';
import { zeroStats, type CampaignStats } from '../domain/campaign.js';
import {
  RecipientOutcome,
  priorityOf,
  type OutcomeStatus,
  type RecipientOutcomeProps,
} from '../domain/recipient-outcome.js';
import type {
  ApplyOutcomeEvent,
  ListOutcomesOptions,
  RecipientOutcomeRepository,
} from '../application/recipient-outcome-repository.js';

/**
 * A real in-memory `RecipientOutcomeRepository` (not a mock) — the DI-rebind
 * test seam (ADR-003).
 *
 * It mirrors the Mongo implementation's **semantics**, not just its signatures:
 * the same dedupe-key check, the same only-ever-raise rule, and the same
 * "returns false when nothing changed" contract. Those are the behaviors the
 * webhook path depends on, so a double that skipped them would let the fast
 * suite pass while the real store lost events.
 */
@injectable()
export class InMemoryRecipientOutcomeRepository implements RecipientOutcomeRepository {
  private readonly store = new Map<string, RecipientOutcomeProps>();

  private key(sendId: string, address: string): string {
    return `${sendId}::${address}`;
  }

  async createMany(outcomes: readonly RecipientOutcome[]): Promise<void> {
    for (const outcome of outcomes) {
      this.store.set(this.key(outcome.sendId, outcome.address), {
        id: outcome.id,
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
      });
    }
  }

  async markAccepted(sendId: string, now: Date): Promise<void> {
    for (const props of this.store.values()) {
      if (props.sendId === sendId && props.status === 'pending') {
        props.status = 'accepted';
        props.statusPriority = priorityOf('accepted');
        props.updatedAt = now;
      }
    }
  }

  async applyEvent(event: ApplyOutcomeEvent): Promise<boolean> {
    const { sendId, address, effect, dedupeKey, now } = event;
    if (effect.kind === 'ignore') return false;

    const props = this.store.get(this.key(sendId, address));
    if (props === undefined) return false;
    // Same guard as the store-side filter: a replayed webhook changes nothing.
    if (dedupeKey !== null && props.applied.includes(dedupeKey)) return false;

    if (effect.kind === 'raise') {
      const priority = priorityOf(effect.status);
      // Only ever raise — an out-of-order lesser event is a no-op, and must
      // not even record its dedupe key, matching the Mongo filter.
      if (priority <= props.statusPriority) return false;
      props.status = effect.status;
      props.statusPriority = priority;
    } else {
      props[effect.field] += 1;
    }

    if (dedupeKey !== null) props.applied.push(dedupeKey);
    props.updatedAt = now;
    return true;
  }

  async stats(sendId: string): Promise<CampaignStats> {
    const rows = [...this.store.values()].filter((p) => p.sendId === sendId);
    const count = (status: OutcomeStatus): number =>
      rows.filter((r) => r.status === status).length;

    const stats = zeroStats();
    stats.recipients = rows.length;
    stats.rejected = count('rejected');
    stats.delivered = count('delivered');
    stats.softBounced = count('soft-bounced');
    stats.bounced = count('bounced');
    stats.complained = count('complained');
    stats.accepted = stats.recipients - stats.rejected - count('pending');
    return stats;
  }

  async list(options: ListOutcomesOptions): Promise<RecipientOutcome[]> {
    let rows = [...this.store.values()]
      .filter((p) => p.sendId === options.sendId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    if (options.statuses !== undefined && options.statuses.length > 0) {
      const wanted = new Set<OutcomeStatus>(options.statuses);
      rows = rows.filter((r) => wanted.has(r.status));
    }
    if (options.cursor !== undefined) {
      rows = rows.filter((r) => r.id > options.cursor!);
    }

    return rows.slice(0, options.limit).map((p) => RecipientOutcome.reconstitute({ ...p }));
  }
}
