# ADR-004: Headless / API-Only

## Status

Accepted — 2026-07-19.

## Context

cablegram is a **headless** newsletter manager/sender — a MailChimp-shaped capability that ships **no
bundled UI**. Like a headless CMS, it exists precisely to be consumed by UIs (build-your-own, or a
first-party one later). So **"headless / API-only" means _no UI in this repo_ — not "the API has no
user-facing concerns."** The rendering client is out of scope; everything a client authenticates and
talks to *is* the product.

The distinction matters because it's easy to over-read: **"API-only" scopes out the UI, not
API-surface concerns like authentication.** User accounts and login are part of the API
([ADR-013](ADR-013-authentication-user-accounts.md)) — a UI is just their eventual front-end. What's
out of scope here is a browser client and client-side state, nothing more.

Stating it as a decision also fixes where product weight lands: with no bundled UI, **the API
contract *is* the product**, so contract stability, validation, and versioning matter more than any
client-side concern.

## Decision

- cablegram ships **no UI**. The only delivery mechanism is an **HTTP JSON API** served by Hono
  (ADR-006). A UI (build-your-own or a later first-party one) lives in its own repo and consumes this
  API.
- **User-facing API concerns are in scope.** "Headless / API-only" excludes the *rendering UI*, not
  the authentication and user-account model a UI (or any client) needs — those are a first-class part
  of the API surface (ADR-013), not something "no UI" waves away.
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
- ADR-013 — Authentication & user accounts (part of the API surface — "headless" does not exclude it)
