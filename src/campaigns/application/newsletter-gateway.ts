/**
 * A consumer-owned port over the `newsletters` context (ADR-001: interfaces
 * live with their consumer). The campaigns context depends only on this narrow
 * view — "does the target newsletter exist, and what is its sender identity?" —
 * never on the `newsletters` facade directly. The adapter that fulfils it
 * (`infrastructure/`) is one of the places campaigns reaches across a component
 * boundary along the ADR-011 DAG (`campaigns → newsletters`).
 */

/** The slice of a newsletter the campaigns context needs (its sender identity). */
export interface CampaignSender {
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyTo: string | null;
}

export interface NewsletterGateway {
  /** The newsletter's sender identity, or `null` when no newsletter has that id. */
  find(newsletterId: string): Promise<CampaignSender | null>;
}
