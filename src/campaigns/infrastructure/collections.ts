import type { CollectionIndexes } from '../../shared/persistence/index.js';

/**
 * The collections `campaigns` owns, and the indexes they need (ADR-017).
 *
 * Naming is `<singular component>_<aggregate>` — the prefix names the owning
 * bounded context, so a bare name in a shell, a slow-query log or a backup
 * manifest is no longer anonymous. Applied uniformly, stutter included
 * (`campaign_campaigns`), because a rule with no exceptions is worth more than
 * four avoided repetitions.
 */
export const CAMPAIGN_COLLECTIONS = {
  campaigns: 'campaign_campaigns',
  /**
   * One small document per send. Renamed from `campaign_send_records`, which
   * described neither its contents nor its scope; the per-recipient ledger it
   * used to embed now lives in `recipientOutcomes` (ADR-019).
   */
  sends: 'campaign_sends',
  /** One document per recipient per send (ADR-019). */
  recipientOutcomes: 'campaign_recipient_outcomes',
  /**
   * One document per *kind* of provider event we received and did not act on
   * (issue #29) — not one per event, so this stays a handful of rows forever.
   */
  unhandledEvents: 'campaign_unhandled_events',
} as const;

export const campaignIndexes: CollectionIndexes[] = [
  // Scoped listing: campaigns for one newsletter.
  { collection: CAMPAIGN_COLLECTIONS.campaigns, indexes: [{ key: { newsletterId: 1 } }] },
  // A send is always reached from its campaign.
  { collection: CAMPAIGN_COLLECTIONS.sends, indexes: [{ key: { campaignId: 1 } }] },
  {
    collection: CAMPAIGN_COLLECTIONS.recipientOutcomes,
    indexes: [
      // The identity of a recipient row, and the key every webhook update
      // filters on. Unique because a send must not open two rows for one
      // address — that would split its outcome and double-count the stats.
      { key: { sendId: 1, address: 1 }, unique: true },
      // Report filtering ("show me the bounces") and the stats grouping.
      { key: { sendId: 1, status: 1 } },
      // Cursor-paginated listing walks `_id` within a send.
      { key: { sendId: 1, _id: 1 } },
    ],
  },
  // The bucket key *is* the `_id`, and the whole collection is a handful of
  // rows read by a human — so `_id` alone suffices and there is nothing to
  // index. It is still declared, because the registry (and `indexes.test.ts`)
  // is the record of which component owns which collection (ADR-017).
  { collection: CAMPAIGN_COLLECTIONS.unhandledEvents, indexes: [] },
];
