import type { CampaignContentRef } from '../domain/campaign.js';

/**
 * A consumer-owned port over the `templates` context (ADR-001). Resolves a
 * campaign's content — a template reference **or** inline bodies — and renders
 * it to a send-ready message against a merge model (ADR-008: rendering happens
 * in-app before the one provider call). The adapter reaches the `templates`
 * facade along the DAG edge `campaigns → templates`; a missing template or
 * unrenderable source surfaces as a `CampaignContentError`.
 *
 * Note: a broadcast is one shared rendered message for the whole recipient set
 * (the `email` gateway fans out a single content), so the send path renders
 * once against an empty model — per-recipient merge is not a bulk-send feature.
 */
export interface RenderedCampaignMessage {
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
}

export interface MessageRenderer {
  render(
    content: CampaignContentRef,
    model: Record<string, unknown>,
  ): Promise<RenderedCampaignMessage>;
}
