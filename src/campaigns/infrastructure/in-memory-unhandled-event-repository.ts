import { injectable } from 'inversify';
import type {
  RecordUnhandledEvent,
  UnhandledEventRecord,
  UnhandledEventRepository,
} from '../application/unhandled-event-repository.js';

/**
 * A real in-memory `UnhandledEventRepository` — the DI-rebind test seam
 * (ADR-003).
 *
 * It mirrors the Mongo implementation's semantics, not just its signatures: one
 * row per key, the sample pinned to the first payload seen, and the same
 * count-descending ordering. Those are the behaviors the route and webhook
 * tests assert on.
 */
@injectable()
export class InMemoryUnhandledEventRepository implements UnhandledEventRepository {
  private readonly store = new Map<string, UnhandledEventRecord>();

  async record(entry: RecordUnhandledEvent): Promise<void> {
    const existing = this.store.get(entry.key);
    if (existing === undefined) {
      this.store.set(entry.key, {
        key: entry.key,
        count: 1,
        sample: entry.sample,
        firstSeenAt: entry.now,
        lastSeenAt: entry.now,
      });
      return;
    }
    existing.count += 1;
    existing.lastSeenAt = entry.now;
  }

  async list(): Promise<UnhandledEventRecord[]> {
    return [...this.store.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}
