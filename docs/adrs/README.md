# cablegram — Architecture Decision Records

cablegram is a **headless newsletter manager/sender**: a MailChimp-shaped capability with **no UI —
APIs only**. These ADRs are its first settled set of architecture decisions.

## The stack these ADRs encode

- **TypeScript**, **Hono** HTTP server, **Inversify** DI, **MongoDB native driver** (ADR-012,
  superseding Prisma in ADR-007).
- **DB-agnostic in the code, MongoDB in production** — repositories stay DB-neutral (ADR-012).
- **Postmark** as the default email backend, behind a pluggable `DeliveryGateway` (ADR-008).
- Deploys to **DigitalOcean Functions / App Platform**, with an **eventual Docker image** (ADR-009).
- **Single-tenant** (ADR-010).

## Index

| ADR | Title | Status |
|---|---|---|
| [001](ADR-001-clean-architecture.md) | Clean Architecture | Accepted |
| [002](ADR-002-package-by-component.md) | Package-by-Component | Accepted |
| [003](ADR-003-dependency-injection.md) | Dependency Injection (Inversify) | Accepted |
| [004](ADR-004-headless-api-only.md) | Headless / API-only | Accepted |
| [005](ADR-005-boundary-enforcement.md) | Boundary Enforcement | Accepted |
| [006](ADR-006-http-delivery-hono.md) | HTTP Delivery with Hono | Accepted |
| [007](ADR-007-persistence-prisma-mongodb.md) | Persistence — Prisma + MongoDB, DB-portable | Superseded by 012 |
| [008](ADR-008-email-delivery-postmark.md) | Email Delivery — Postmark Bulk behind a gateway | Accepted |
| [009](ADR-009-deployment-digitalocean-functions.md) | Deployment — DigitalOcean Functions → Docker | Accepted |
| [010](ADR-010-single-tenant.md) | Single-Tenant model | Accepted |
| [011](ADR-011-bounded-contexts.md) | Bounded Contexts & Component Topology | Accepted |
| [012](ADR-012-persistence-mongodb-native-driver.md) | Persistence — MongoDB Native Driver behind the repository seam | Accepted |
| [013](ADR-013-authentication-user-accounts.md) | Authentication & User Accounts (JWT, roles) | Accepted — implemented |
| [014](ADR-014-passwordless-magic-link-login.md) | Passwordless Magic-Link Login | Accepted — implemented |
| [015](ADR-015-public-token-unsubscribe.md) | Public Token Unsubscribe & RFC 8058 List-Unsubscribe | Accepted — implemented |
| [016](ADR-016-cli-client.md) | A First-Party CLI — an API *client*, not a delivery mechanism | Accepted — implemented |
| [017](ADR-017-component-owned-collections.md) | Component-Owned Collections & the `<component>_<aggregate>` naming rule | Accepted — implemented |
| [018](ADR-018-suppression-scope.md) | Suppression Scope — global for mailbox facts, per-newsletter for consent | Accepted — implemented |
| [019](ADR-019-per-recipient-outcome-documents.md) | Per-Recipient Outcome Documents (splitting the send record) | Accepted — implemented |
| [020](ADR-020-soft-bounce-streak.md) | Soft-Bounce Streaks — counting transient failures without over-reacting | Accepted — implemented |
| [021](ADR-021-unhandled-webhook-events.md) | Unhandled Webhook Events — recording what the receiver cannot act on | Accepted — implemented |
| [022](ADR-022-subscriber-import.md) | Subscriber Import — restoring state, not creating consent | Accepted — implemented |
| [023](ADR-023-consent-record.md) | The Consent Record — timestamps and evidence for each consent moment | Accepted — implemented |
| [024](ADR-024-custom-fields.md) | Custom Fields — naming the bag, and naming what is still undecided | Accepted — implemented |
| [025](ADR-025-campaign-test-send.md) | Campaign Test Send — a proof that is the same send | Accepted — implemented |
| [026](ADR-026-release-and-distribution.md) | Release & Distribution — release-please, npm, trusted publishing | Accepted — implemented |
| [027](ADR-027-library-entrypoint.md) | A Library Entrypoint — mounting cablegram inside a host service | Accepted — implemented |

## How to read these

Each ADR records **a decision and its why**, so you can re-evaluate rather than cargo-cult. ADR-001
through 005 fix the foundational architecture (layers, component structure, DI, headless posture,
boundary enforcement); ADR-006 through 011 pin cablegram's stack and domain choices. ADR-011 names
the five bounded contexts — the one call the earlier ADRs leave open — and is now ratified. ADR-012
supersedes ADR-007, swapping Prisma for the MongoDB native driver behind the same repository seam.

New decisions use `_TEMPLATE.md`.

## Also see

- [`../deployment.md`](../deployment.md) — how ADR-009 is actually shipped (Docker image build,
  the in-app index bootstrap, the DO Functions caveats, CI).
- [`../testing.md`](../testing.md) — the two test suites (fast in-memory default, real-Mongo
  integration) and why `mongodb-memory-server` was picked over testcontainers.
- [`../releasing.md`](../releasing.md) — how ADR-026 is actually operated (the release PR flow, the
  one-time npm trusted-publisher setup, and what a missing credential looks like).
- [`../embedding.md`](../embedding.md) — how ADR-027 is actually consumed (mounting the app in a host
  service, and the two things — `BASE_URL`, duplicate logging — the host owns).
