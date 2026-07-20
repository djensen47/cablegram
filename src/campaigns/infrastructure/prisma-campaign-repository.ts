import { inject, injectable } from 'inversify';
import type { Prisma, PrismaClient, Campaign as CampaignRow } from '@prisma/client';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { Campaign, type CampaignId, type CampaignStats, type CampaignStatus } from '../domain/campaign.js';
import type {
  CampaignRepository,
  ListCampaignsOptions,
} from '../application/campaign-repository.js';

/**
 * The Mongo-backed `CampaignRepository` (ADR-007). Prisma stays sealed inside
 * this class: it maps rows to/from the domain aggregate and never lets a Prisma
 * type escape into `application/` or `domain/`. Pagination is an id-ordered,
 * exclusive-cursor sweep (`id > cursor`) — the portable subset, no skip/offset.
 * `stats` is stored as an opaque JSON snapshot (like `subscriptions.mergeFields`).
 *
 * Unverified against a live Mongo until the deployment chunk (per the build
 * plan); the in-memory repository is the tested contract meanwhile.
 */
@injectable()
export class PrismaCampaignRepository implements CampaignRepository {
  constructor(@inject(SHARED_TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async create(campaign: Campaign): Promise<void> {
    await this.prisma.campaign.create({ data: toRow(campaign) });
  }

  async update(campaign: Campaign): Promise<void> {
    const { id, ...data } = toRow(campaign);
    await this.prisma.campaign.update({ where: { id }, data });
  }

  async findById(id: CampaignId): Promise<Campaign | null> {
    const row = await this.prisma.campaign.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async list(options: ListCampaignsOptions): Promise<Campaign[]> {
    const rows = await this.prisma.campaign.findMany({
      where: {
        ...(options.newsletterId === undefined ? {} : { newsletterId: options.newsletterId }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.cursor === undefined ? {} : { id: { gt: options.cursor } }),
      },
      orderBy: { id: 'asc' },
      take: options.limit,
    });
    return rows.map(toDomain);
  }

  async delete(id: CampaignId): Promise<boolean> {
    const { count } = await this.prisma.campaign.deleteMany({ where: { id } });
    return count > 0;
  }
}

// The write shape: identical to `CampaignRow` except `stats` is the input JSON
// type (the aggregate always holds a `CampaignStats` object, never `null`).
type CampaignWriteData = Omit<CampaignRow, 'stats'> & {
  stats: Prisma.InputJsonValue;
};

function toRow(campaign: Campaign): CampaignWriteData {
  return {
    id: campaign.id,
    newsletterId: campaign.newsletterId,
    name: campaign.name,
    templateId: campaign.templateId,
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    bodyText: campaign.bodyText,
    segmentTags: [...campaign.segmentTags],
    status: campaign.status,
    sendId: campaign.sendId,
    stats: campaign.stats as unknown as Prisma.InputJsonValue,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    sentAt: campaign.sentAt,
  };
}

function toDomain(row: CampaignRow): Campaign {
  // `status` is only ever written from the closed `CampaignStatus` set and
  // `stats` from a `CampaignStats` object, so a stored row is trusted at the
  // repository boundary (same stance as sibling repositories).
  return Campaign.reconstitute({
    id: row.id,
    newsletterId: row.newsletterId,
    name: row.name,
    templateId: row.templateId,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    segmentTags: row.segmentTags,
    status: row.status as CampaignStatus,
    sendId: row.sendId,
    stats: row.stats as unknown as CampaignStats,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt,
  });
}
