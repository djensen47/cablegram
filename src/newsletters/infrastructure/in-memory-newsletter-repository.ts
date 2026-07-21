import { injectable } from 'inversify';
import type { Newsletter, NewsletterId } from '../domain/newsletter.js';
import type {
  ListNewslettersOptions,
  NewsletterRepository,
} from '../application/newsletter-repository.js';

/**
 * A real in-memory `NewsletterRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). It mirrors the Mongo repository's contract exactly: id
 * ordering, exclusive cursor, `limit` cap, so use-case and route tests exercise
 * the same behavior the Mongo-backed repository must honor.
 */
@injectable()
export class InMemoryNewsletterRepository implements NewsletterRepository {
  private readonly store = new Map<NewsletterId, Newsletter>();

  async create(newsletter: Newsletter): Promise<void> {
    this.store.set(newsletter.id, newsletter);
  }

  async findById(id: NewsletterId): Promise<Newsletter | null> {
    return this.store.get(id) ?? null;
  }

  async list(options: ListNewslettersOptions): Promise<Newsletter[]> {
    const ordered = [...this.store.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = options.cursor;
    const filtered = after === undefined ? ordered : ordered.filter((n) => n.id > after);
    return filtered.slice(0, options.limit);
  }

  async update(newsletter: Newsletter): Promise<void> {
    this.store.set(newsletter.id, newsletter);
  }

  async delete(id: NewsletterId): Promise<boolean> {
    return this.store.delete(id);
  }
}
