# ADR-004: Headless / API-Only

## Status

Accepted — 2026-07-19.

## Context

cablegram is a **headless** newsletter manager/sender — a MailChimp-shaped capability exposed **only
as an HTTP JSON API**. There is no browser client, no React, and no client-side state to manage. Any
UI (an admin console, a dashboard) is a *separate consumer* of this API, out of scope for this repo.

This is worth stating explicitly as a decision, because "no UI" is not merely the absence of a
frontend — it changes where product surface area lives. With no UI, **the API contract *is* the
product**, and design weight shifts onto contract stability, validation, and versioning rather than
onto client-side concerns.

## Decision

- cablegram ships **no UI**. The only delivery mechanism is an **HTTP JSON API** served by Hono
  (ADR-006). A first-party UI, if ever built, lives in its own repo and consumes this API.
- Consequently there is **no** client-side state layer (no TanStack Query, no Zustand) and **no**
  frontend DI boundary — DI is a backend-only concern (ADR-003).
- Because the API is the product surface, treat it accordingly: **explicit request/response DTOs**
  (never leak domain entities or Prisma types over the wire), **input validation at the edge**
  (ADR-006), stable error shapes, and **deliberate versioning** of breaking changes.
- Webhook **receivers** (e.g. Postmark event webhooks, ADR-008) are part of this API surface — they
  are inbound HTTP handlers, not a UI.

## Consequences

- Smaller stack, fewer moving parts: no client build, no client state library, no SSR concerns.
- The `presentation/` layer (ADR-001) is exclusively HTTP handlers — no view/component code.
- More weight lands on **API design and contract stability**, since consumers are other programs.
- If a first-party UI is ever built, its own client-state and DI concerns are decided *there*, in
  that repo — not here.

## Related

- ADR-001 — Clean Architecture (`presentation/` is HTTP-only here)
- ADR-003 — Dependency Injection (backend-only; no frontend DI boundary)
- ADR-006 — HTTP delivery with Hono (the one delivery mechanism)
