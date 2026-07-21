import type { Template, TemplateId } from '../domain/template.js';

/** Options for a forward-only, cursor-paginated list (ADR-007 portable subset). */
export interface ListTemplatesOptions {
  /** Max rows to return. Callers pass `pageSize + 1` to detect a next page. */
  limit: number;
  /** Exclusive lower bound: return templates whose id sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for templates. Lives in `application/` next to its
 * consumers (ADR-001) — the MongoDB native driver is one implementation behind it (ADR-012), the
 * in-memory double another. Repositories deal in domain aggregates, never
 * driver documents or DTOs.
 */
export interface TemplateRepository {
  create(template: Template): Promise<void>;
  findById(id: TemplateId): Promise<Template | null>;
  /** Templates ordered by id ascending, `id > cursor`, capped at `limit`. */
  list(options: ListTemplatesOptions): Promise<Template[]>;
  update(template: Template): Promise<void>;
  /** Returns `true` if a row was deleted, `false` if none existed. */
  delete(id: TemplateId): Promise<boolean>;
}
