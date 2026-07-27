/**
 * A consumer-owned port over the `deliverability` context (ADR-001), for the
 * one thing `subscriptions` legitimately learns about a **mailbox** rather than
 * about a relationship: an imported hard bounce (ADR-022).
 *
 * ADR-018 draws the line by what kind of fact a signal is. A bounce carried in
 * a migration file says *"this mailbox was already dead at the old provider"* —
 * that is a fact about the address, true for every newsletter, and it is exactly
 * what the global list is for. A complaint in the same file is a fact about one
 * publication's relationship and **never** reaches this port.
 *
 * Adding it introduced the DAG edge `subscriptions → deliverability`
 * (ADR-011/ADR-022): acyclic, since `deliverability` imports no component.
 */
export interface SuppressionGateway {
  /**
   * Put addresses on the global suppression list as permanent bounces.
   * Idempotent, and quiet about malformed addresses — an import must not fail
   * a batch of good subscribers over a hygiene side effect.
   */
  suppressHardBounced(addresses: readonly string[]): Promise<void>;
}
