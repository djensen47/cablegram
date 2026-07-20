import type { SuppressionSignal } from '../domain/send-record.js';

/**
 * A consumer-owned port over the `deliverability` context (ADR-001). Two
 * responsibilities, both driven by campaigns (never by the leaf `email`
 * adapter, ADR-008):
 *  - **gate 2** of the send path: drop already-suppressed addresses before the
 *    provider call (subscribed *and* not suppressed);
 *  - record hard-bounce / spam-complaint addresses onto cablegram's own
 *    authoritative suppression list when webhooks arrive.
 *
 * The adapter reaches the `deliverability` facade along the DAG edge
 * `campaigns → deliverability`.
 */
export interface SuppressionGateway {
  /** Given addresses, return the subset currently on the suppression list. */
  filterSuppressed(addresses: readonly string[]): Promise<string[]>;
  /** Add an address to the suppression list (idempotent). */
  suppress(signal: SuppressionSignal): Promise<void>;
}
