import type { Campaign, CampaignId, CampaignStatus } from '../domain/campaign.js';

/** Options for a forward-only, cursor-paginated list (ADR-007 portable subset). */
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
 * consumers (ADR-001) — Prisma is one implementation behind it (ADR-007), the
 * in-memory double another. Deals in domain aggregates, never Prisma rows or
 * DTOs.
 */
export interface CampaignRepository {
  create(campaign: Campaign): Promise<void>;
  update(campaign: Campaign): Promise<void>;
  findById(id: CampaignId): Promise<Campaign | null>;
  /** Campaigns ordered by id ascending, `id > cursor`, capped at `limit`. */
  list(options: ListCampaignsOptions): Promise<Campaign[]>;
  /** Returns `true` if a row was deleted, `false` if none existed. */
  delete(id: CampaignId): Promise<boolean>;
  /**
   * The scheduling seam (ADR-009's open item): `scheduled` campaigns whose
   * `scheduledAt` has passed `before`, ordered by `scheduledAt` ascending
   * (oldest-due first) then `id` (a stable tie-break), capped at `limit`. No
   * cursor — `dispatch-due` re-runs this fresh each tick; a campaign drops out
   * of the due set the moment it transitions past `scheduled`, so there is
   * nothing to page through within one call (ADR-009: no in-process timer,
   * an external cron calls this repeatedly instead).
   */
  listDue(before: Date, limit: number): Promise<Campaign[]>;
}
