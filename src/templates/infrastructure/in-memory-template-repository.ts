import { injectable } from 'inversify';
import type { Template, TemplateId } from '../domain/template.js';
import type {
  ListTemplatesOptions,
  TemplateRepository,
} from '../application/template-repository.js';

/**
 * A real in-memory `TemplateRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). It mirrors the Prisma repository's contract exactly: id
 * ordering, exclusive cursor, `limit` cap, so use-case and route tests exercise
 * the same behavior the Mongo-backed repository must honor.
 */
@injectable()
export class InMemoryTemplateRepository implements TemplateRepository {
  private readonly store = new Map<TemplateId, Template>();

  async create(template: Template): Promise<void> {
    this.store.set(template.id, template);
  }

  async findById(id: TemplateId): Promise<Template | null> {
    return this.store.get(id) ?? null;
  }

  async list(options: ListTemplatesOptions): Promise<Template[]> {
    const ordered = [...this.store.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = options.cursor;
    const filtered = after === undefined ? ordered : ordered.filter((t) => t.id > after);
    return filtered.slice(0, options.limit);
  }

  async update(template: Template): Promise<void> {
    this.store.set(template.id, template);
  }

  async delete(id: TemplateId): Promise<boolean> {
    return this.store.delete(id);
  }
}
