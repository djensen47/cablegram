# ADR-011: Bounded Contexts & Component Topology

## Status

Accepted — 2026-07-19. The topology below is the ratified result of the domain discussion. This is
the domain call ADR-002 leaves open; splitting a coarse boundary later stays cheap (see "Deliberately
coarse / not yet").

## Context

Package-by-component (ADR-002) requires us to name the actual components — the top-level capabilities
that each bundle their own Clean layers and sit behind an `index.ts` facade. ADR-002's guidance is to
**start coarse and split**, because re-slicing an existing boundary is the expensive case while
splitting a coarse one is cheap.

cablegram is **single-tenant** (ADR-010) but **multi-newsletter**: one account runs many newsletters.
Tenant ≠ newsletter. That, plus a deliberate choice about identity (below), shapes the map.

### The test: does it have its own domain?

A **domain component** is a capability with its own domain model — an entity with rules, invariants,
and persistence. Things that look like components but aren't fall into two buckets, and knowing
*which* tells us where they go:

- **A data category** — "events" (a delivery, a bounce, an open) are *facts applied to* other
  aggregates, not a capability. No `events` component; an event is routed to the aggregates it
  concerns.
- **A gateway to an external system** — "delivery" (sending mail, translating the ESP's callbacks)
  is pure infrastructure with no domain of its own. Not a component; a **shared module** (`email`).

### One deliberate identity decision

**There is no global `Contact` identity.** Subscriptions are **flat and independent**: `email` is a
*field* on a subscription, not a key into a shared person. The same address subscribed to two
newsletters is **two independent records** — duplication is intended. The *only* thing that reaches
across newsletters by address is the **suppression list**, which lives in `deliverability`.

## Decision (proposed)

### Domain components (`src/<component>/`)

Five. Each is a folder with `domain/ application/ infrastructure/ presentation/` inside and an
`index.ts` facade (ADR-001, ADR-002):

- **`newsletters`** — the *publication*: identity, **sender identity** (from-name/email), **sending
  domain / DKIM**, and defaults (default template, reply-to). Owns `NewsletterRepository`. The thing
  subscriptions attach to and campaigns belong to. *Supporting subdomain.*
- **`subscriptions`** — **per-newsletter, independent** membership: `email` + fields + status
  (subscribed / pending / unsubscribed), and segments. No cross-newsletter identity. Owns
  `SubscriptionRepository`. Resolves "who is subscribed to newsletter X." *Core subdomain.*
- **`deliverability`** — **global, address-keyed** sending hygiene. Its first (today, only) aggregate
  is the **suppression list**: a deny-list of addresses cablegram must never send to, tagged by
  `reason` (hard bounce / spam complaint / manual junk / global opt-out) + timestamp. This is the
  forward-looking home for reputation and rate/throttle policy *if* cablegram ever owns those (today
  they're delegated to Postmark, ADR-008). *Supporting subdomain.*
- **`templates`** — reusable layouts + **rendering** to HTML/text. A template is a shared library
  asset, reusable across newsletters and campaigns (not owned by either). Owns `TemplateRepository`
  and a `TemplateRenderer`. *Supporting subdomain.*
- **`campaigns`** — a newsletter *issue* / one broadcast: belongs to a newsletter, references a
  template (optional — inline content is allowed), carries content + targeting, and holds
  the **send record** (per-recipient outcomes + aggregate stats). Owns `CampaignRepository`.
  Orchestrates the send and the applying-back of events. *Core subdomain.*

### Shared technical modules (`src/shared/`)

Small, focused, each its own facade, each a **leaf** that imports no domain component (ADR-005):

- **`email`** — the **ESP adapter** (anti-corruption layer around Postmark): a `DeliveryGateway`
  interface + `PostmarkDeliveryGateway` (Bulk API, ADR-008) + `parseProviderEvent(raw) →
  DeliveryEvent[]`. Consumed by `campaigns` (broadcasts) and `subscriptions` (transactional opt-in /
  unsubscribe confirmations).
- **`auth`** — JWT access-token issue/verify seam (`jose`, HS256) plus opaque refresh-token helpers;
  consumed by `accounts` (issuing) and `shared/http`'s `jwtAuth` (verifying). JWT-only, no API key
  (ADR-013).
- **`config`** (env, ADR-009) · **`ids`** (id value objects, ADR-012) · **`clock`** · **`http`**
  (Hono middleware, ADR-006) · **`di`** (composition root, ADR-003).

### Cross-component workflows

- **Send (outbound):** `campaigns` send use case → `newsletters` (sender identity) →
  `subscriptions.resolveRecipients(newsletterId)` → **filter against `deliverability`** (two gates:
  *subscribed?* **and** *not suppressed?*) → `templates.render()` → `email.send()` (Postmark bulk;
  Postmark owns the fan-out, ADR-008).
- **Events (inbound):** a Postmark webhook hits an inbound handler (ADR-006) →
  `email.parseProviderEvent(raw)` normalizes it → `campaigns` records the outcome on its send record;
  a hard bounce / complaint **adds the address to `deliverability`'s suppression list**. Suppression
  then blocks that address on every newsletter's next send.

All hops go through facades (ADR-005).

### Acyclic graph

`campaigns` orchestrates and depends on the others; the shared `email` adapter depends on **no**
domain component (so suppression is enforced in the `campaigns` send use case, *not* in the adapter —
the adapter is a leaf). Result is a DAG:

```
campaigns     → { newsletters, subscriptions, deliverability, templates, email }
subscriptions → { newsletters }          (validate the newsletter a subscription targets)
newsletters   → { templates }            (only if it names a default template)
deliverability, templates, email, auth, shared/* → leaves
```

This is the shape ADR-005's boundary rules enforce.

### Deliberately coarse / not yet

- **Reputation and rate/throttle policy** will join `deliverability` when cablegram owns them; today
  Postmark does (ADR-008), so `deliverability` holds only the suppression list.
- **No `Contact` identity** — intentional (above). Reconstructing a cross-newsletter view (e.g. GDPR
  erasure) is an address-keyed sweep across subscriptions + suppression, not a delete of one record.
- **Compliance/consent audit** (proof of consent, `List-Unsubscribe`/RFC 8058 records) is likely a
  future shared audit concern, not a context yet.
- **Scheduling** out of `campaigns` (ties to the open scheduling question in ADR-009);
  **analytics/reporting** out of `campaigns` send stats.

## Consequences

- **Five** domain components + shared modules. The top level *screams* the newsletter domain
  (ADR-002): publications, their audiences, deliverability, content, and broadcasts.
- The identity decision keeps `subscriptions` simple (flat rows) at the cost of no unified contact
  profile — accepted; the only cross-newsletter fact we track by address is suppression.
- `deliverability` is named for a real ubiquitous-language concept, so it earns its name even with
  one aggregate today, and gives reputation/rate policy a home without a later rename.
- `email` is a clean ESP anti-corruption boundary both directions; swapping providers (ADR-008)
  touches only `send` and `parseProviderEvent`. cablegram keeps its **own authoritative** suppression
  list, independent of the ESP's, which is what makes the swap real.
- If ratified, the ESLint boundary rules (ADR-005) are configured against exactly these components
  and the acyclic graph above, on day one.

## Related

- ADR-002 — Package-by-component (the scheme this instantiates)
- ADR-001 — Clean Architecture (layers inside each component; gateways as interfaces)
- ADR-005 — Boundary enforcement (rules configured against these components + the DAG)
- ADR-008 — Email delivery (the `email` module; suppression enforcement in the send path)
- ADR-010 — Single-tenant (one account, many newsletters)
- ADR-009 — Deployment (open scheduling question touches `campaigns`)
