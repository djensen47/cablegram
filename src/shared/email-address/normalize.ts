/**
 * The single canonical email-address normalizer (shared leaf, ADR-002/005).
 * Both `deliverability` (suppression keys) and `subscriptions` (membership
 * keys) normalize through this function so the two always agree on identity
 * for the same address — a suppression entry reliably matches the
 * subscription rows it must block.
 *
 * Policy: trim surrounding whitespace, lowercase the whole address. Plus-
 * addressing (`user+tag@example.com`) is deliberately **not** collapsed —
 * `user+tag@example.com` and `user@example.com` are treated as distinct
 * addresses. Mail providers do not uniformly honor `+` folding, and silently
 * merging identities here would be a surprising, provider-dependent behavior
 * for a suppression/subscription key. Local-part case is preserved apart from
 * the blanket lowercase (most providers treat the local part as
 * case-insensitive in practice; RFC 5321 permits case-sensitivity, but
 * lowercasing keeps this normalizer simple, deterministic, and consistent
 * with `EmailAddress` in `newsletters`).
 */
export function normalizeEmailAddress(raw: string): string {
  return raw.trim().toLowerCase();
}
