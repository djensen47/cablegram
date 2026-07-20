import { inject, injectable } from 'inversify';
import type { PrismaClient, Template as TemplateRow } from '@prisma/client';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { Template, type TemplateId } from '../domain/template.js';
import type {
  ListTemplatesOptions,
  TemplateRepository,
} from '../application/template-repository.js';

/**
 * The Mongo-backed `TemplateRepository` (ADR-007). Prisma stays sealed inside
 * this class: it maps rows to/from the domain aggregate and never lets a Prisma
 * type escape into `application/` or `domain/`. Pagination is an id-ordered,
 * exclusive-cursor sweep (`id > cursor`) — the portable subset, no skip/offset.
 *
 * Unverified against a live Mongo until the deployment chunk (per the build
 * plan); the in-memory repository is the tested contract meanwhile.
 */
@injectable()
export class PrismaTemplateRepository implements TemplateRepository {
  constructor(@inject(SHARED_TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async create(template: Template): Promise<void> {
    await this.prisma.template.create({ data: toRow(template) });
  }

  async findById(id: TemplateId): Promise<Template | null> {
    const row = await this.prisma.template.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async list(options: ListTemplatesOptions): Promise<Template[]> {
    const rows = await this.prisma.template.findMany({
      where: options.cursor === undefined ? undefined : { id: { gt: options.cursor } },
      orderBy: { id: 'asc' },
      take: options.limit,
    });
    return rows.map(toDomain);
  }

  async update(template: Template): Promise<void> {
    const { id, ...data } = toRow(template);
    await this.prisma.template.update({ where: { id }, data });
  }

  async delete(id: TemplateId): Promise<boolean> {
    const { count } = await this.prisma.template.deleteMany({ where: { id } });
    return count > 0;
  }
}

function toRow(template: Template): TemplateRow {
  return {
    id: template.id,
    name: template.name,
    subject: template.subject,
    bodyHtml: template.bodyHtml,
    bodyText: template.bodyText,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function toDomain(row: TemplateRow): Template {
  return Template.reconstitute({
    id: row.id,
    name: row.name,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
