# ADR-023: The Consent Record — Timestamps and Evidence for Each Consent Moment

## Status

Accepted — 2026-07-27. Extends [ADR-022](ADR-022-subscriber-import.md) §2.

## Context

ADR-022 established that `createdAt` is the consent record and must survive an import, and added
`source` so an inherited consent claim stays distinguishable from one cablegram witnessed. Reviewing
what a consent challenge actually asks for showed the record was still missing most of itself.

### `updatedAt` was silently destroying the answer

There was no `confirmedAt`. `confirm()` moved `status` and `updatedAt`, and nothing else. But
`updatedAt` means *"when did this row last change"*, and it is rewritten by every later event — a
soft bounce, a delivery resetting the streak, a status flip from a webhook. So the moment a
subscriber confirmed double opt-in was erased by the next bounce, and it was already unrecoverable.

Under GDPR that is the wrong field to lose. The **confirmation** is the consent act; the signup is
only an assertion that someone typed an address. `createdAt` answers "when did they ask", and nothing
answered "when did they agree". `unsubscribedAt` had the same problem: CAN-SPAM gives ten days to
honour an opt-out, and proving you did needs the timestamp of the opt-out, not of the row's last edit.

### And a timestamp alone is thin evidence

A date with no corroborating detail is an assertion by the operator's own database. The conventional
record — MailChimp's `OPTIN_IP` and equivalents everywhere else — pairs each consent moment with the
IP and user-agent observed at the time. It is not proof, but it is the corroboration a challenge asks
for, and its value is that it exists at all.

### Why "just capture it automatically" does not work here

The obvious implementation is to read the IP off the request. That is wrong in this architecture, and
the reason is worth recording because it looks like an oversight otherwise.

**cablegram is headless** ([ADR-004](ADR-004-headless-api-only.md)). There is no subscriber-facing
signup form; every `/v1` route is called by the operator's own backend holding a JWT. The IP of a
request arriving at `POST /subscriptions` is the **operator's server**. Recording it as the
subscriber's would not merely be useless — it would write false consent evidence, which is worse than
a blank field, because a blank field says "unknown" while a wrong one says something untrue in the
one situation where the record gets read.

A second constraint makes the mechanics worse. On DigitalOcean Functions there is no socket at all:
`function.ts` rebuilds a `Request` from OpenWhisk's `__ow_headers` ([ADR-009](ADR-009-deployment-digitalocean-functions.md)),
so a forwarding header is the only thing that could carry a client address, and the leftmost
`X-Forwarded-For` entry — the one that identifies the original client — is also the one a client can
freely invent.

## Decision

### 1. Three consent moments, each with its own timestamp and evidence

| moment | timestamp | evidence |
|---|---|---|
| signup | `createdAt` *(already existed)* | `signupIp`, `signupUserAgent` |
| confirmation (double opt-in) | **`confirmedAt`** | `confirmedIp`, `confirmedUserAgent` |
| opt-out | **`unsubscribedAt`** | `unsubscribedIp`, `unsubscribedUserAgent` |

All optional; absence means "never observed", and it is stored as an absent field rather than a null.
There is no `signupAt` — `createdAt` already is it, and two fields obliged to agree forever is a bug
waiting to happen.

`confirmedAt` is empty on a single-opt-in row, because no confirmation ever happened. That is a real
distinction and the schema should show it rather than paper over it with `createdAt`.

### 2. Evidence is passed in on `/v1`; auto-captured only on the public unsubscribe

- `POST /subscriptions` takes `signupIp` / `signupUserAgent` in the body.
- `POST …/confirm` and `POST …/{id}/unsubscribe` take an optional `{ ip, userAgent }` body.
- **`POST /v1/unsubscribe`** (the public, token-authenticated route,
  [ADR-015](ADR-015-public-token-unsubscribe.md)) is the **only** place cablegram reads the request,
  because it is the only route whose caller genuinely is the recipient or their mail client. Even
  there the value is partial: an RFC 8058 one-click POST originates from the mail provider's servers,
  so what is recorded is "who submitted the opt-out", not always "who read the mail".

The forwarded value is taken from the **leftmost** `X-Forwarded-For` entry and is **validated as an
IP** — anything else is dropped rather than stored, because a field that sometimes holds an address
and sometimes holds `unknown` proves nothing. It is recorded as corroboration, never as proof.

### 3. The trail is replaced wholesale, never half-kept

- `resubscribe()` **clears** the previous trail and records new signup evidence: a stale
  `unsubscribedAt` on an active membership, or a `confirmedAt` predating the current opt-in, would
  describe a sequence of events that never happened. Under double opt-in the following confirm fills
  `confirmedAt` in again; under single opt-in it stays empty.
- `unsubscribe()` is idempotent **including its evidence** — the first opt-out is the one that counts,
  so a repeated one-click POST cannot rewrite when it happened.
- An import's `--on-conflict overwrite` replaces the whole trail, for the same reason: this file's
  signup IP beside the previous import's confirmation would be fiction.
- Everything else (`markBounced`, `markComplained`, the soft-bounce counter) leaves the trail alone.

### 4. Imports restore the trail verbatim

All eight fields are importable and are **reserved CSV columns**, joining `email` / `tags` / `status`
/ `subscribedAt` / `source`. Reserving them is the same call ADR-022 made for `source` and matters
more here: an unreserved `signupIp` column would become a *custom field*, which both loses the record
and makes a subscriber's IP renderable into a campaign body.

An ESP export carrying opt-in IPs is carrying the most valuable thing in the file after the addresses
themselves, and it cannot be reconstructed after the fact — which is why these fields had to exist
before the pending 18k migration runs, not after.

### 5. An unrelated bug this surfaced

Giving `confirm` and `unsubscribe` an optional body broke them. Hono's validator parses the body
whenever `content-type: application/json` is present and throws on an empty one *before* zod runs, so
neither `required: false` nor an all-optional schema helps — and most HTTP clients set that header on
a bodyless POST. Both routes are called with no body today, so this was a 500 on the existing
contract.

Fixed by `optionalJsonBody` in `shared/http`, which substitutes `{}` for an empty JSON body. The
alternative — hand-parsing in the handler — would have bought the same tolerance by deleting the
schema from the OpenAPI document, and ADR-004 makes the contract the product.

## Consequences

- **The consent record is now answerable.** "When did they agree, and what did you observe" has a
  home for every membership, and no later event overwrites it.
- **Eight new nullable fields on the subscription DTO.** That is a wide record, but each is a distinct
  fact and collapsing them into a nested object would either duplicate `createdAt` or invent a
  `signupAt` to match it.
- **`signupIp` is PII.** Storing it needs a retention answer that this ADR does not give — no TTL, no
  redaction, no export/erasure endpoint. That gap is named rather than hidden, and it is an argument
  for these being fixed fields rather than loose in a bag: a fixed field can be found and redacted.
- **The evidence is unverified, everywhere.** On `/v1` it is whatever the operator's front end
  reported; on the public unsubscribe it is a spoofable header. Treating it as proof would be a
  mistake — it is corroboration, and the ADR says so rather than letting a future reader assume more.
- **Operators must do work to get any of it.** A blank `signupIp` is the default outcome unless the
  signup form relays it. That is the honest cost of being headless, and the alternative (recording the
  operator's own backend IP) is the thing this ADR exists to prevent.
- **`confirmedAt` is not backfillable.** Rows confirmed before this shipped have no confirmation
  timestamp and never will; only `updatedAt` remains, and it has already moved. Nothing is live yet,
  so the practical blast radius is zero — but the general shape of the loss is why the field exists.

## Related

- [ADR-022](ADR-022-subscriber-import.md) — established `createdAt`-as-consent-record and `source`
- [ADR-004](ADR-004-headless-api-only.md) — why auto-capture cannot work on `/v1`
- [ADR-015](ADR-015-public-token-unsubscribe.md) — the one route whose caller is the subscriber
- [ADR-009](ADR-009-deployment-digitalocean-functions.md) — no socket on DO Functions
