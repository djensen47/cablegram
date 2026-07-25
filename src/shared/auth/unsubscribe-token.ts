import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed message an unsubscribe token authenticates: the `(newsletter,
 * subscription)` pair. The `subscriptionId` alone already pins down exactly one
 * row (it is a globally unique app-owned `_id`, ADR-012); the `newsletterId` is
 * folded in so the signature is **bound to the newsletter** — a token minted for
 * one newsletter cannot verify against another even if the id in the link is
 * swapped, honoring the flat per-newsletter model (ADR-011). The `:` separator
 * is unambiguous because app-owned ids never contain one.
 */
function signedMessage(newsletterId: string, subscriptionId: string): string {
  return `${newsletterId}:${subscriptionId}`;
}

/**
 * Mint a **stateless** unsubscribe token: `HMAC-SHA256(secret, newsletterId:sub
 * scriptionId)`, URL-safe base64 (ADR-015). Unlike the single-use, expiring
 * `one_time_tokens` (password-reset / magic-link), this is deterministic and
 * long-lived by design — a link in a years-old email must still verify — so it
 * is derived, never stored: no DB column, no migration, no expiry. Rotating the
 * secret invalidates every outstanding link at once.
 *
 * The caller supplies the secret (from `config.unsubscribe.tokenSecret`, which
 * falls back to the JWT secret); this stays a pure `shared/*` leaf, like
 * `newOpaqueToken()`.
 */
export function unsubscribeToken(
  secret: string,
  newsletterId: string,
  subscriptionId: string,
): string {
  return createHmac('sha256', secret)
    .update(signedMessage(newsletterId, subscriptionId))
    .digest('base64url');
}

/**
 * Verify a presented unsubscribe token by recomputing the expected HMAC and
 * comparing in **constant time**. A forged token, or a genuine token presented
 * with a mismatched `newsletterId`, both fail closed. Length is checked first so
 * `timingSafeEqual` only ever sees equal-length buffers (it throws otherwise).
 */
export function verifyUnsubscribeToken(
  secret: string,
  newsletterId: string,
  subscriptionId: string,
  presented: string,
): boolean {
  const expected = Buffer.from(unsubscribeToken(secret, newsletterId, subscriptionId));
  const actual = Buffer.from(presented);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
