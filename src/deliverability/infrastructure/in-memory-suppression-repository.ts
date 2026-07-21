import { injectable } from 'inversify';
import { SuppressionEntry } from '../domain/suppression.js';
import type {
  ListSuppressionsOptions,
  SuppressionRepository,
} from '../application/suppression-repository.js';

/**
 * A real in-memory `SuppressionRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). It mirrors the Mongo repository's contract exactly:
 * address ordering, exclusive cursor, `limit` cap, idempotent `add`, so
 * use-case and route tests exercise the same behavior the Mongo-backed
 * repository must honor.
 */
@injectable()
export class InMemorySuppressionRepository implements SuppressionRepository {
  private readonly store = new Map<string, SuppressionEntry>();

  async add(entry: SuppressionEntry): Promise<SuppressionEntry> {
    const existing = this.store.get(entry.address);
    if (existing) return existing;
    this.store.set(entry.address, entry);
    return entry;
  }

  async findByAddress(address: string): Promise<SuppressionEntry | null> {
    return this.store.get(address) ?? null;
  }

  async list(options: ListSuppressionsOptions): Promise<SuppressionEntry[]> {
    const ordered = [...this.store.values()].sort((a, b) =>
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    );
    const after = options.cursor;
    const filtered = after === undefined ? ordered : ordered.filter((e) => e.address > after);
    return filtered.slice(0, options.limit);
  }

  async remove(address: string): Promise<boolean> {
    return this.store.delete(address);
  }

  async filterSuppressed(addresses: string[]): Promise<string[]> {
    return addresses.filter((address) => this.store.has(address));
  }
}
