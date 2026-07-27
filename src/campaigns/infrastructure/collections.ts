import type { CollectionIndexes } from '../../shared/persistence/index.js';

/**
 * The collections `campaigns` owns, and the indexes they need (ADR-017).
 *
 * Naming is `<singular component>_<aggregate>` — the prefix names the owning
 * bounded context, so a bare `send_records` in a shell, a slow-query log or a
 * backup manifest is no longer anonymous. The convention is applied uniformly,
 * stutter included (`campaign_campaigns`), because a rule with no exceptions is
 * worth more than four avoided repetitions.
 */
export const CAMPAIGN_COLLECTIONS = {
  campaigns: 'campaign_campaigns',
  sendRecords: 'campaign_send_records',
} as const;

export const campaignIndexes: CollectionIndexes[] = [
  // Scoped listing: campaigns for one newsletter.
  { collection: CAMPAIGN_COLLECTIONS.campaigns, indexes: [{ key: { newsletterId: 1 } }] },
  // A send record is always reached from its campaign.
  { collection: CAMPAIGN_COLLECTIONS.sendRecords, indexes: [{ key: { campaignId: 1 } }] },
];
