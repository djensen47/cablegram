import { injectable } from 'inversify';
import { Campaign, type CampaignId, type CampaignStatus } from '../domain/campaign.js';
import type {
  CampaignRepository,
  ListCampaignsOptions,
} from '../application/campaign-repository.js';

/**
 * A real in-memory `CampaignRepository` (not a mock) — the DI-rebind test seam
 * (ADR-003). It mirrors the Mongo repository's contract exactly: id ordering,
 * exclusive cursor, `limit` cap and the `newsletterId`/`status` query filters —
 * so use-case and route tests exercise the same behavior the Mongo-backed
 * repository must honor.
 *
 * That includes **what a read is**. Mongo builds a new object from stored state
 * on every read, so two requests each hold their own copy and neither sees the
 * other's unsaved changes. This double used to hand every reader the one stored
 * object, which made two overlapping sends look safe here while both submitted
 * against the real store (ADR-035). It now copies on the way in and on the way
 * out.
 */
@injectable()
export class InMemoryCampaignRepository implements CampaignRepository {
  private readonly store = new Map<string, Campaign>();

  async create(campaign: Campaign): Promise<void> {
    this.store.set(campaign.id, copyOf(campaign));
  }

  async update(campaign: Campaign): Promise<void> {
    this.store.set(campaign.id, copyOf(campaign));
  }

  async saveIfStatus(campaign: Campaign, from: readonly CampaignStatus[]): Promise<boolean> {
    const stored = this.store.get(campaign.id);
    if (stored === undefined || !from.includes(stored.status)) return false;
    this.store.set(campaign.id, copyOf(campaign));
    return true;
  }

  async findById(id: CampaignId): Promise<Campaign | null> {
    const stored = this.store.get(id);
    return stored === undefined ? null : copyOf(stored);
  }

  async list(options: ListCampaignsOptions): Promise<Campaign[]> {
    const ordered = [...this.store.values()]
      .filter((c) => options.newsletterId === undefined || c.newsletterId === options.newsletterId)
      .filter((c) => options.status === undefined || c.status === options.status)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = options.cursor;
    const filtered = after === undefined ? ordered : ordered.filter((c) => c.id > after);
    return filtered.slice(0, options.limit).map(copyOf);
  }

  async delete(id: CampaignId): Promise<boolean> {
    return this.store.delete(id);
  }
}

/** A detached copy — what a stored document turns into on its way through a driver. */
function copyOf(campaign: Campaign): Campaign {
  return Campaign.reconstitute({
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
    recipientCount: campaign.recipientCount,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    sentAt: campaign.sentAt,
  });
}
