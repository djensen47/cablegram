# ADR-015: Public Token Unsubscribe & RFC 8058 List-Unsubscribe

## Status

Accepted — 2026-07-24. **Implemented** the same day.

## Context

Until now the only way to unsubscribe was `POST /v1/newsletters/{newsletterId}/subscriptions/{id}/unsubscribe`
— an **operator** action behind the `/v1` JWT gate ([ADR-013](ADR-013-authentication-user-accounts.md)).
A newsletter recipient has no session and no operator, so a subscriber clicking "unsubscribe" in an
email had nothing they could hit. Two things need a **public**, credential-free-but-authenticated path:

- **The human "unsubscribe" link** at the foot of a newsletter — a browser `GET` the recipient clicks.
- **RFC 8058 one-click unsubscribe** — the "Unsubscribe" button Gmail/Apple Mail render in their own
  chrome. The mail client (not the person) `POST`s a `List-Unsubscribe` URL in the background with body
  `List-Unsubscribe=One-Click`. Bulk senders increasingly *must* provide this to stay out of spam
  folders; it needs a URL that unsubscribes with no UI and returns `200`.

The design question is how a public caller proves it may unsubscribe *this* subscription without a
login, across a link that may be years old.

## Decision

A **public, token-authenticated** unsubscribe surface at a fixed open path, plus per-recipient
`List-Unsubscribe` headers on every campaign send.

### Stateless HMAC token — not the one-time-token store

The credential is a **stateless HMAC**: `token = HMAC-SHA256(secret, "<newsletterId>:<subscriptionId>")`,
URL-safe base64, verified by recomputing and comparing in constant time (`shared/auth`,
`unsubscribeToken` / `verifyUnsubscribeToken`). This is deliberately **not** the expiring, single-use
`one_time_tokens` store ([ADR-013](ADR-013-authentication-user-accounts.md)/[ADR-014](ADR-014-passwordless-magic-link-login.md)):

- An unsubscribe link must **work forever** — a link in a three-year-old email must still unsubscribe —
  and be **idempotent**, the opposite of single-use-and-expiring.
- Being **derived, not stored**, it needs no column, no migration, and no new collection. The existing
  `(newsletterId, email)` compound index is untouched.
- The `subscriptionId` alone identifies the row; the `newsletterId` is **folded into the signature** so
  a token minted for one newsletter cannot be replayed against another even if the id in the URL is
  swapped — honoring the flat, per-newsletter model ([ADR-011](ADR-011-bounded-contexts.md)).
- The secret is `UNSUBSCRIBE_TOKEN_SECRET`, which **falls back to `JWT_SECRET`** when unset (the same
  fallback shape as the transactional Postmark token). A dedicated secret decouples link validity from
  JWT-secret rotation; rotating the unsubscribe secret invalidates every outstanding link at once.

### One fixed, open endpoint — `/v1/unsubscribe`

Because `OPEN_V1_PATHS` in `src/app.ts` is an **exact-match** set, the endpoint is a **fixed** path,
`/v1/unsubscribe`, carrying `newsletterId`, `subscriptionId` and `token` as query parameters — added as
one entry to `OPEN_V1_PATHS` with no change to the JWT gate. (A parameterized path under the nested
subscriptions router could not be exact-matched there.) Two methods on it:

- **`GET`** — the human's body link. Verifies the token, flips the subscription to `unsubscribed`
  (reusing the domain `subscription.unsubscribe(now)`; idempotent), then either **`302`-redirects** to a
  configured landing page (`UNSUBSCRIBE_REDIRECT_ENABLED` + `UNSUBSCRIBE_REDIRECT_URL`, with the address
  on the query string) or renders a small, self-contained HTML confirmation.
- **`POST`** — the RFC 8058 one-click target. Same verification and effect, always returns `200` (mail
  clients don't render a body or follow redirects).

The use case is **non-revealing and idempotent**: a forged/mismatched token is a flat `400`; a valid
token whose row no longer exists succeeds quietly; an already-unsubscribed row is a `200` no-op — none
of these leak whether an address is subscribed. The operator JWT endpoint is **kept unchanged** — the
two serve different callers.

### Per-recipient List-Unsubscribe headers on sends

`campaigns` builds, **per recipient**, an absolute `List-Unsubscribe: <https://…/v1/unsubscribe?…>`
header (the URL carries that subscriber's own token) plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
This required:

- surfacing each recipient's `subscriptionId` through the resolve-recipients projection
  (`subscriptions`) and the `campaigns` recipient port, so the send path can mint the token;
- extending the `email` port's `EmailRecipient` with optional per-recipient `headers`, which the
  Postmark adapter maps onto the Bulk API's per-message `Headers` array (message-level headers take
  precedence — verified against the live Bulk API docs, [ADR-008](ADR-008-email-delivery-postmark.md)).
  The `email` module stays a leaf: it transports headers verbatim and ascribes them no meaning.

The API's own public origin is a new `BASE_URL` — the first time cablegram links back to **itself**
(the account-mail bases point at an operator front-end instead). When `BASE_URL` is unset, sends simply
omit the headers; delivery is unaffected.

### Unsubscribe ≠ suppression

Unsubscribing flips **per-newsletter status only**. It does **not** add the address to the global
`deliverability` suppression list — that list is for hard bounces and complaints
([ADR-011](ADR-011-bounded-contexts.md)). The two stay separate.

## Consequences

- Recipients can self-serve unsubscribe with no account, and mailbox providers get a compliant
  one-click button — improving deliverability of the broadcast stream.
- No new persistence: the token is computed, not stored, so there is no schema change, no migration, and
  no new index or collection. The swap seam is a config secret, not a table.
- Trade-off: a stateless token can only be revoked **en masse** by rotating `UNSUBSCRIBE_TOKEN_SECRET`,
  not per subscription. That is an accepted cost — an unsubscribe link is low-risk (its only power is to
  stop mail), so global rotation is a sufficient and simple kill switch.
- The `GET` confirmation page is a small HTML surface on an otherwise headless API ([ADR-004](ADR-004-headless-api-only.md)).
  It is unavoidable — a human clicked a link and a browser will render *something* — and is opt-out via
  a redirect to the operator's own page. It serves no application data and consumes no API contract.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — Email delivery; the per-recipient `List-Unsubscribe`
  headers ride the Postmark Bulk API's per-message `Headers`, and this extends the `email` port with
  per-recipient headers.
- [ADR-011](ADR-011-bounded-contexts.md) — Bounded contexts; the token is scoped to `(newsletter,
  subscription)` per the flat per-newsletter model, and unsubscribe is kept distinct from the global
  suppression list.
- [ADR-013](ADR-013-authentication-user-accounts.md) — Auth; this adds an open path to `OPEN_V1_PATHS`
  and deliberately uses a *stateless* token instead of that decision's one-time-token store.
- ADR-001/002/005 — the public use case lives in the `subscriptions` component under the same
  layering/boundary rules; the token helper is a `shared/auth` leaf.
