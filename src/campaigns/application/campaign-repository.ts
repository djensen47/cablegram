import type { Campaign, CampaignId, CampaignStatus } from '../domain/campaign.js';

/** Options for a forward-only, cursor-paginated list (ADR-012 portable subset). */
export interface ListCampaignsOptions {
  /** Optional query-time filters. */
  newsletterId?: string;
  status?: CampaignStatus;
  /** Max rows to return. Callers pass `pageSize + 1` to detect a next page. */
  limit: number;
  /** Exclusive lower bound: return campaigns whose id sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for campaigns. Lives in `application/` next to its
 * consumers (ADR-001) — the MongoDB native driver is one implementation behind it (ADR-012), the
 * in-memory double another. Deals in domain aggregates, never driver documents or
 * DTOs.
 */
export interface CampaignRepository {
  create(campaign: Campaign): Promise<void>;
  /**
   * Store `campaign` only if the stored row is still in one of the `from`
   * statuses. Returns `false`, having written nothing, when it is not (or the
   * row is gone).
   *
   * Every caller read the campaign some time before it writes. The check is
   * made by the store, in the same operation as the write, so two requests that
   * both read `draft` cannot both move the campaign to `sending` — exactly one
   * write matches (ADR-035). The domain decides which statuses a change is
   * legal from; this only makes that decision hold against the stored row.
   *
   * There is deliberately no unconditional `update(campaign)`. Writing back a
   * copy read earlier, whatever the row holds now, is how two overlapping sends
   * both submitted the list.
   */
  saveIfStatus(campaign: Campaign, from: readonly CampaignStatus[]): Promise<boolean>;
  findById(id: CampaignId): Promise<Campaign | null>;
  /** Campaigns ordered by id ascending, `id > cursor`, capped at `limit`. */
  list(options: ListCampaignsOptions): Promise<Campaign[]>;
  /** Returns `true` if a row was deleted, `false` if none existed. */
  delete(id: CampaignId): Promise<boolean>;
}
