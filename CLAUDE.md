# cablegram

Headless newsletter manager/sender — a MailChimp-shaped capability, **APIs only, no UI**. The
architecture is fixed by the ADRs in [`docs/adrs/`](docs/adrs/README.md); this file is the operative
distillation. When a rule here and an ADR disagree, the ADR wins — fix this file.

## Stack

TypeScript · **Hono** HTTP ([ADR-006](docs/adrs/ADR-006-http-delivery-hono.md)) · **Inversify** DI
([ADR-003](docs/adrs/ADR-003-dependency-injection.md)) · **Prisma** on **MongoDB**, code kept
DB-portable ([ADR-007](docs/adrs/ADR-007-persistence-prisma-mongodb.md)) · **Postmark** email behind a
gateway ([ADR-008](docs/adrs/ADR-008-email-delivery-postmark.md)) · deploys on **DigitalOcean
Functions → Docker** ([ADR-009](docs/adrs/ADR-009-deployment-digitalocean-functions.md)) ·
**single-tenant** ([ADR-010](docs/adrs/ADR-010-single-tenant.md)) · **headless**
([ADR-004](docs/adrs/ADR-004-headless-api-only.md)).

## Structure

Package-by-component ([ADR-002](docs/adrs/ADR-002-package-by-component.md)): each capability is a
folder `src/<component>/` fronted by an `index.ts` facade, with Clean layers nested **inside** it
([ADR-001](docs/adrs/ADR-001-clean-architecture.md)):

- `domain/` — entities, value objects, errors. Pure; no IO, no framework, **no outward interfaces**.
- `application/` — use cases **and the interfaces they depend on** (gateways/repositories) + DTOs.
- `infrastructure/` — implementations: Prisma repos, the Postmark adapter, DI wiring.
- `presentation/` — Hono handlers only (no UI).

Shared technical modules live under `src/shared/`, each its own facade.

## Bounded contexts & the dependency DAG ([ADR-011](docs/adrs/ADR-011-bounded-contexts.md))

Domain: `newsletters` · `subscriptions` · `deliverability` · `templates` · `campaigns`.
Shared: `email` (Postmark ACL) · `auth` · `config` · `ids` · `clock` · `http` · `di`.

```
campaigns     → { newsletters, subscriptions, deliverability, templates, email }
subscriptions → { newsletters }
newsletters   → { templates }        (only if it names a default template)
deliverability, templates, email, auth, shared/* → leaves
```

Keep it acyclic. `email` (and every `shared/*`) imports **no** domain component.

## Layer & boundary rules ([ADR-005](docs/adrs/ADR-005-boundary-enforcement.md))

`eslint-plugin-boundaries`, wired day one. Enforced:

1. Import only through a component's `index.ts` facade — never its internals.
2. Dependencies inward only: `domain ← application ← infrastructure/presentation`.
3. Cross-component only via facades.
4. `shared/*` modules are leaves — they cannot import a domain component.

Interfaces live with their **consumer** (in `application/`); implementations reach in from
`infrastructure/`. No `domain/repositories/` or `domain/services/`.

## DI

Inversify, **one composition root** in `shared/di`; each component/module exports a `ContainerModule`.
Inject **interfaces only**. Naming: bare `Thing` interface (no `I`), `<Qualifier>Thing` impl
(`PostmarkDeliveryGateway`, `PrismaSubscriptionRepository`, `DefaultClock`). Tokens in `types.ts`
(`TYPES`); tests **rebind** to mocks. Build the container at **module scope** (ephemeral functions).

## HTTP

Thin handlers: validate input at the edge (zod) → call a use case from the container → map to a
response DTO. **Never** serialize domain entities or Prisma types; use explicit DTOs. Use cases never
see the Hono `Context`. One Hono app, two entrypoints (DO function adapter · `@hono/node-server`).
Mutating POST routes under `/v1` honor an opt-in `Idempotency-Key` header (replay-safe retries; a
reused key with a different body is a 409). Every request gets structured, one-line stdout logging.

## Persistence

Prisma is an infrastructure detail behind repository interfaces. **Portable subset only**: id-ref
relations (no embedded docs / Mongo-only features), app-owned id value objects (`shared/ids`), not raw
`ObjectId`, past the repository. Minimize cross-document transactions (Mongo needs a replica set). The
repository is the swap seam.

## Sending & events ([ADR-008](docs/adrs/ADR-008-email-delivery-postmark.md))

- **Send:** `campaigns` resolves recipients (`subscriptions`), **filters against `deliverability`**
  (two gates — subscribed *and* not suppressed), renders in-app (`templates`), then **one** async
  Postmark Bulk call (`POST /email/bulk`) via `email.send()`. The response is a submission ack (a
  request id), not per-recipient results — `SendRecord` persists it as `bulkRequestId`/`submittedAt`.
  Postmark owns the fan-out — **no queue, no worker, no cursor.**
- **Schedule:** setting `scheduledAt` on a campaign marks it `scheduled`; there's still no in-process
  timer — an external cron drives the protected `POST /v1/campaigns/dispatch-due` endpoint, which runs
  the ordinary send pipeline on each due campaign.
- **Events:** Postmark webhook → `email.parseProviderEvent()` normalizes → `campaigns` records the
  outcome; hard bounce/complaint → add address to the `deliverability` suppression list. The webhook
  is **HTTP Basic-Auth** protected (Postmark has no HMAC/signing) — `POSTMARK_WEBHOOK_SECRET` is the
  Basic-Auth password, checked at the top-level `/webhooks/postmark` route, not the `/v1` API key.
- Suppression is enforced in the `campaigns` send use case, **not** in the `email` adapter (it's a
  leaf). cablegram owns its **own** authoritative suppression list.

## Deployment ([ADR-009](docs/adrs/ADR-009-deployment-digitalocean-functions.md))

Stateless & ephemeral everywhere: no background workers, no long in-request loops, no local disk / in-
memory state between requests. Config from env vars. Mongo is the only durable state; pool at module
scope.

## Gotchas

- **No `Contact` identity.** Subscriptions are flat and per-newsletter; the same email in two
  newsletters is two independent records — duplication is intended. The only cross-newsletter fact by
  address is suppression.
- **Tenant ≠ newsletter.** Single-tenant (one account), but many newsletters. `newsletterId` is
  ordinary domain data, not a tenant scope — no tenant/account id on entities.
- **No `events` component and no `delivery` component** — events are facts applied to aggregates;
  sending is the shared `email` adapter.
- **Postmark wire format** (request/response, webhook schema) is implemented in
  `src/shared/email/postmark-delivery-gateway.ts` and `src/campaigns/presentation/webhook-routes.ts` —
  treat that code (or live docs) as the source of truth, not memory, before restating a Postmark fact
  in docs or code. Two facts worth not re-getting-wrong: the Bulk API (`POST /email/bulk`) is
  asynchronous with no per-call recipient cap (only a 50 MB payload ceiling), and webhook auth is
  HTTP Basic, not HMAC.
