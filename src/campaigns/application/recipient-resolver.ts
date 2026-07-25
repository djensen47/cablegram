import type { CampaignSegment } from '../domain/campaign.js';

/**
 * A consumer-owned port over the `subscriptions` context (ADR-001) — **gate 1**
 * of the send path (ADR-008): resolve the subscribed recipients for a
 * newsletter, narrowed by the campaign's query-time segment. Suppression is a
 * *separate* gate applied afterwards (`SuppressionGateway`), never here. The
 * adapter reaches the `subscriptions` facade along the DAG edge
 * `campaigns → subscriptions`.
 */

/** A resolved send target: an address plus the per-recipient merge model. */
export interface CampaignRecipient {
  /** The subscription's id — used to mint the per-recipient unsubscribe token
   * for the `List-Unsubscribe` header (ADR-015). */
  readonly subscriptionId: string;
  readonly address: string;
  readonly mergeModel: Record<string, unknown>;
}

export interface RecipientResolver {
  resolve(newsletterId: string, segment: CampaignSegment): Promise<CampaignRecipient[]>;
}
