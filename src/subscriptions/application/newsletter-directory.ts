/**
 * A consumer-owned port over the `newsletters` context (ADR-001: interfaces
 * live with their consumer). The subscribe use case depends only on this narrow
 * view — "does the target newsletter exist, and what is its sender identity?" —
 * never on the `newsletters` facade directly. The adapter that fulfils it
 * (`infrastructure/`) is the single place that reaches across the component
 * boundary along the ADR-011 DAG (`subscriptions → newsletters`).
 */

/** The slice of a newsletter the subscriptions context needs. */
export interface NewsletterInfo {
  readonly id: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyTo: string | null;
}

export interface NewsletterDirectory {
  /** The newsletter's info, or `null` when no newsletter has that id. */
  find(newsletterId: string): Promise<NewsletterInfo | null>;
}
