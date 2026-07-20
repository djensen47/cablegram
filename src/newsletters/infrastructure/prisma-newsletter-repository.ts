import { inject, injectable } from 'inversify';
import type { PrismaClient, Newsletter as NewsletterRow } from '@prisma/client';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { EmailAddress, Newsletter, type NewsletterId } from '../domain/newsletter.js';
import type {
  ListNewslettersOptions,
  NewsletterRepository,
} from '../application/newsletter-repository.js';

/**
 * The Mongo-backed `NewsletterRepository` (ADR-007). Prisma stays sealed inside
 * this class: it maps rows to/from the domain aggregate and never lets a Prisma
 * type escape into `application/` or `domain/`. Pagination is an id-ordered,
 * exclusive-cursor sweep (`id > cursor`) — the portable subset, no skip/offset.
 *
 * Unverified against a live Mongo until the deployment chunk (per the build
 * plan); the in-memory repository is the tested contract meanwhile.
 */
@injectable()
export class PrismaNewsletterRepository implements NewsletterRepository {
  constructor(@inject(SHARED_TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async create(newsletter: Newsletter): Promise<void> {
    await this.prisma.newsletter.create({ data: toRow(newsletter) });
  }

  async findById(id: NewsletterId): Promise<Newsletter | null> {
    const row = await this.prisma.newsletter.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async list(options: ListNewslettersOptions): Promise<Newsletter[]> {
    const rows = await this.prisma.newsletter.findMany({
      where: options.cursor === undefined ? undefined : { id: { gt: options.cursor } },
      orderBy: { id: 'asc' },
      take: options.limit,
    });
    return rows.map(toDomain);
  }

  async update(newsletter: Newsletter): Promise<void> {
    const { id, ...data } = toRow(newsletter);
    await this.prisma.newsletter.update({ where: { id }, data });
  }

  async delete(id: NewsletterId): Promise<boolean> {
    const { count } = await this.prisma.newsletter.deleteMany({ where: { id } });
    return count > 0;
  }
}

function toRow(newsletter: Newsletter): NewsletterRow {
  return {
    id: newsletter.id,
    name: newsletter.name,
    fromName: newsletter.fromName,
    fromEmail: newsletter.fromEmail.value,
    replyTo: newsletter.replyTo?.value ?? null,
    sendingDomain: newsletter.sendingDomain,
    dkimIdentifier: newsletter.dkimIdentifier,
    createdAt: newsletter.createdAt,
    updatedAt: newsletter.updatedAt,
  };
}

function toDomain(row: NewsletterRow): Newsletter {
  return Newsletter.reconstitute({
    id: row.id,
    name: row.name,
    fromName: row.fromName,
    fromEmail: EmailAddress.create(row.fromEmail),
    replyTo: row.replyTo === null ? null : EmailAddress.create(row.replyTo),
    sendingDomain: row.sendingDomain,
    dkimIdentifier: row.dkimIdentifier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
