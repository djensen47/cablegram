# ADR-008: Email Delivery — Postmark Bulk behind a Gateway

## Status

Accepted — 2026-07-19.

## Context

cablegram must fan a newsletter out to many recipients. It runs on **ephemeral, time-limited**
DigitalOcean Functions (ADR-009), so it **cannot** run long in-process loops or its own sending
workers. The recipient fan-out must be owned by something built for it.

We use an **ESP (Email Service Provider)** for the actual delivery — the party that owns SMTP, IP
reputation, throttling, retries, and bounce/complaint feedback. The default is **Postmark**, chosen
for deliverability and a simple API. Postmark's **Bulk Email API** (`POST /email/bulk`) is a single
call that takes the content once plus a per-recipient list and **fans the send out on Postmark's
side**, **asynchronously** — the call returns a submission acknowledgment (a request id), not
per-recipient results; those arrive later via webhooks. The only payload constraint is a **50 MB**
ceiling — there is no per-call recipient-count cap on this endpoint (that cap belongs to the separate,
transactional `/email/batch` endpoint, which cablegram does not use). Pinned to what
`PostmarkDeliveryGateway` implements (`src/shared/email/postmark-delivery-gateway.ts`), not asserted
from memory.

Two things kept separate on purpose:

- **cablegram = the newsletter manager** — owns subscriptions, campaigns, templates, and the record of
  who should receive what.
- **the ESP = the delivery pipe** — cablegram hands it "send this content to these recipients"; the
  ESP delivers and reports outcomes back via webhooks.

> Note: the exact Postmark request/response and webhook schemas were pinned against the live Postmark
> docs when the gateway was implemented (`src/shared/email/postmark-delivery-gateway.ts`,
> `src/campaigns/presentation/webhook-routes.ts`) — this ADR fixes the *architecture*, not Postmark's
> wire format. Treat the code, not this document, as the source of truth for wire-level detail; verify
> against it (or live docs) before restating a Postmark fact here.

## Decision

### A pluggable DeliveryGateway

- Sending email is a **shared technical capability**, not a domain component — it's a gateway to an
  external system with no domain of its own (ADR-011). It lives in the shared `email` module: a
  **`DeliveryGateway`** interface consumed by `campaigns` (broadcasts) and `subscriptions`
  (transactional opt-in / unsubscribe confirmations). The default implementation is
  **`PostmarkDeliveryGateway`**, using Postmark's **Bulk Email API**. Alternate implementations
  (SMTP, SES, …) are rebindable via DI (ADR-003) — Postmark is not hardwired into use cases.

### Send model: one bulk call, ESP owns the fan-out

- A campaign-send use case: resolves recipients (via `subscriptions`), **filters them against the
  `deliverability` suppression list** (two gates — subscribed *and* not suppressed), renders content
  (via `templates`), and calls `DeliveryGateway.send(...)` **once** with the surviving recipient set.
- The gateway issues **one** `POST /email/bulk` call; Postmark performs the fan-out
  **asynchronously** — the response is a submission acknowledgment (`{ ID, Status, SubmittedAt }`),
  not per-recipient results. cablegram does **not** run a queue, a worker, or a resumable batch cursor
  — the ephemeral-function problem is Postmark's to solve, not ours. The campaign's `SendRecord`
  persists the returned request id and submission time (`bulkRequestId`, `submittedAt`) so later
  webhook events can be correlated back to the send.
- The only cablegram-side concern is the **50 MB payload ceiling**; the current gateway makes a
  **single** `POST /email/bulk` call per send and does **not** split a large recipient set across
  multiple calls. If a broadcast's payload nears the ceiling, that's a gap to close in the gateway,
  not the use case — recorded here rather than asserted as already handled.

### Per-recipient outcomes via webhooks

- Delivery/bounce/open/click/spam outcomes arrive as **Postmark webhooks**, received by an inbound
  HTTP handler (ADR-006). The shared `email` module **normalizes** the raw payload into
  provider-agnostic events (`parseProviderEvent`); `campaigns` then **records the outcome** on its
  send record, and a hard bounce / complaint **adds the address to the `deliverability` suppression
  list** (ADR-011). There is no `events` component — the facts live on the aggregates they describe.
  The bulk send call itself is not where per-recipient status lives.
- The webhook receiver is **HTTP Basic-Auth protected, not HMAC/signature-verified** — Postmark's
  webhook mechanism has no signing, only Basic Auth on the callback URL (and IP allowlisting).
  `POSTMARK_WEBHOOK_SECRET` (`shared/config`) is the Basic-Auth password the receiver checks with a
  constant-time comparison, not a signing key; the username is ignored. This is why the route is
  mounted at the **top level** with its own middleware instead of behind the `/v1` API key
  (`src/campaigns/presentation/webhook-routes.ts`).

## Consequences

- The send path fits an ephemeral function trivially: build payload → one (or few) API call → return.
  No background infrastructure to run or operate.
- Deliverability, throttling, and retries are Postmark's problem, not bespoke code.
- We depend on Postmark's availability for sends and on its webhooks for outcomes; the gateway
  boundary keeps that dependency swappable, but a swap to a non-bulk provider (e.g. raw SMTP) would
  re-introduce fan-out concerns the Bulk API currently absorbs — recorded so that cost is visible.
- Rendering happens **in cablegram** (`templates`), and pre-rendered content is sent; we do not host
  templates in the provider, keeping the gateway thin and provider-agnostic (consistent with ADR-012
  portability and the ADR-004 "contract is the product" stance).

## Related

- ADR-001 — Clean Architecture (`DeliveryGateway` interface in `application/`)
- ADR-003 — Dependency Injection (default + alternate gateway implementations)
- ADR-006 — HTTP delivery (inbound webhook receivers)
- ADR-009 — Deployment (why long-running send workers are off the table)
- ADR-011 — Bounded contexts (`newsletters`, `subscriptions`, `deliverability`, `templates`,
  `campaigns`; sending is the shared `email` module, not a component)
