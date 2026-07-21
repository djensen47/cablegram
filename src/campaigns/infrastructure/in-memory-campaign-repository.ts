import { injectable } from 'inversify';
import type { Campaign, CampaignId } from '../domain/campaign.js';
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
 */
@injectable()
export class InMemoryCampaignRepository implements CampaignRepository {
  private readonly store = new Map<string, Campaign>();

  async create(campaign: Campaign): Promise<void> {
    this.store.set(campaign.id, campaign);
  }

  async update(campaign: Campaign): Promise<void> {
    this.store.set(campaign.id, campaign);
  }

  async findById(id: CampaignId): Promise<Campaign | null> {
    return this.store.get(id) ?? null;
  }

  async list(options: ListCampaignsOptions): Promise<Campaign[]> {
    const ordered = [...this.store.values()]
      .filter((c) => options.newsletterId === undefined || c.newsletterId === options.newsletterId)
      .filter((c) => options.status === undefined || c.status === options.status)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = options.cursor;
    const filtered = after === undefined ? ordered : ordered.filter((c) => c.id > after);
    return filtered.slice(0, options.limit);
  }

  async delete(id: CampaignId): Promise<boolean> {
    return this.store.delete(id);
  }

  async listDue(before: Date, limit: number): Promise<Campaign[]> {
    return [...this.store.values()]
      .filter((c) => c.status === 'scheduled' && c.scheduledAt !== null && c.scheduledAt.getTime() <= before.getTime())
      .sort((a, b) => {
        const byTime = (a.scheduledAt as Date).getTime() - (b.scheduledAt as Date).getTime();
        return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, limit);
  }
}
