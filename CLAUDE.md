# cablegram

Headless newsletter manager/sender — a MailChimp-shaped capability, **APIs only, no UI**. The
architecture is fixed by the ADRs in [`docs/adrs/`](docs/adrs/README.md); this file is the operative
distillation. When a rule here and an ADR disagree, the ADR wins — fix this file.

## Stack

TypeScript · **Hono** HTTP ([ADR-006](docs/adrs/ADR-006-http-delivery-hono.md)) · **Inversify** DI
([ADR-003](docs/adrs/ADR-003-dependency-injection.md)) · **MongoDB native driver**, code kept
DB-portable ([ADR-012](docs/adrs/ADR-012-persistence-mongodb-native-driver.md)) · **Postmark** email behind a
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
- `infrastructure/` — implementations: Mongo repos, the Postmark adapter, DI wiring.
- `presentation/` — Hono handlers only (no UI).

Shared technical modules live under `src/shared/`, each its own facade.

## Bounded contexts & the dependency DAG ([ADR-011](docs/adrs/ADR-011-bounded-contexts.md))

Domain: `newsletters` · `subscriptions` · `deliverability` · `templates` · `campaigns` · `accounts`.
Shared: `email` (Postmark ACL) · `auth` (JWT + generic opaque-token helpers) · `config` · `ids` ·
`clock` · `http` · `di`.

```
campaigns     → { newsletters, subscriptions, deliverability, templates, email }
subscriptions → { newsletters }
newsletters   → { templates }        (only if it names a default template)
accounts      → { shared/* only }    (user accounts + auth; depends on no domain component)
deliverability, templates, email, auth, shared/* → leaves
```

Keep it acyclic. `email`, `auth` (and every `shared/*`) import **no** domain component.

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
(`PostmarkDeliveryGateway`, `MongoSubscriptionRepository`, `DefaultClock`). Tokens in `types.ts`
(`TYPES`); tests **rebind** to mocks. Build the container at **module scope** (ephemeral functions).

## HTTP

Thin handlers: validate input at the edge (zod) → call a use case from the container → map to a
response DTO. **Never** serialize domain entities or driver documents; use explicit DTOs. Use cases never
see the Hono `Context`. One Hono app, two entrypoints (DO function adapter · `@hono/node-server`).
Mutating POST routes under `/v1` honor an opt-in `Idempotency-Key` header (replay-safe retries; a
reused key with a different body is a 409). Every request gets structured, one-line stdout logging.

## Persistence

The **MongoDB native driver** (`mongodb`) is an infrastructure detail behind repository interfaces
([ADR-012](docs/adrs/ADR-012-persistence-mongodb-native-driver.md), superseding Prisma in ADR-007).
**Portable subset only**: id-ref relations (no embedded docs / Mongo-only features), app-owned string
ids stored as `_id` (`shared/ids`), never raw `ObjectId`, past the repository. Every write is a single
document and **nothing uses transactions**, so **no replica set is needed** — a standalone `mongod`
suffices (proven by the standalone integration suite). One pooled `MongoClient`/`Db` at module scope
(ADR-009); the app creates its own indexes at startup via `ensureIndexes` (`shared/persistence`) —
there is no `prisma generate`/`db push`. The repository is the swap seam.

## Sending & events ([ADR-008](docs/adrs/ADR-008-email-delivery-postmark.md))

- **Send:** `campaigns` resolves recipients (`subscriptions`), **filters against `deliverability`**
  (two gates — subscribed *and* not suppressed), renders in-app (`templates`), then **one** async
  Postmark Bulk call (`POST /email/bulk`) via `email.send()`. The response is a submission ack (a
  request id), not per-recipient results — `SendRecord` persists it as `bulkRequestId`/`submittedAt`.
  Postmark owns the fan-out — **no queue, no worker, no cursor.**
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

## Testing

- `npm test` — unit: use cases + routes, repositories rebound to `InMemory<X>Repository` (ADR-003). No DB.
- `npm run test:integration` — repository contracts vs a standalone in-memory Mongo
  (`mongodb-memory-server`); excluded from the default gate.
- Green gate before commit/PR: `npm run typecheck && npm run lint && npm test` (add `test:integration`
  for persistence changes). No end-to-end suite yet — see `docs/testing.md`.

## Gotchas

- **No `Contact` identity.** Subscriptions are flat and per-newsletter; the same email in two
  newsletters is two independent records — duplication is intended. The only cross-newsletter fact by
  address is suppression.
- **Tenant ≠ newsletter.** Single-tenant (one account), but many newsletters. `newsletterId` is
  ordinary domain data, not a tenant scope — no tenant/account id on entities.
- **No `events` component and no `delivery` component** — events are facts applied to aggregates;
  sending is the shared `email` adapter.
- **No scheduled campaigns (v1).** Sending is on-demand only (`POST /v1/campaigns/{id}/send`); a
  campaign's lifecycle is `draft → sending → sent | failed` (no `scheduled` status, no `scheduledAt`).
  Scheduled sends + their time trigger are **deferred to Phase 2** — do not reintroduce a
  `dispatch-due` endpoint or an in-process timer; the design + the DO-native trigger plan live in
  [ADR-009](docs/adrs/ADR-009-deployment-digitalocean-functions.md).
- **No Prisma.** Persistence is the **native MongoDB driver** ([ADR-012](docs/adrs/ADR-012-persistence-mongodb-native-driver.md));
  Prisma was removed and **ADR-007 is historical**. Do not reintroduce `prisma` / `@prisma/client` or
  `prisma generate` / `db push`, and don't follow ADR-007's Prisma mechanics. No replica set is
  needed — a standalone `mongod` suffices.
- **Auth is JWT-only; there is no API key.** `/v1` is protected by a per-user **Bearer access JWT**
  ([ADR-013](docs/adrs/ADR-013-authentication-user-accounts.md)); the old static `API_KEYS` /
  `apiKeyAuth` are **gone** — don't reintroduce them. cablegram is single-tenant but **multi-user**:
  the `accounts` component owns `User` (roles `admin` | `manager`, first-user-is-admin via one-time
  `POST /v1/setup`). The open `/v1` routes are `setup`, `auth/login`, `auth/refresh`, `auth/logout`,
  **`auth/password-reset` + `auth/password-reset/confirm`**, **`auth/magic-link` +
  `auth/magic-link/consume`**, and **`unsubscribe`** (the public token unsubscribe, ADR-015) — all
  listed in `OPEN_V1_PATHS` (an **exact-match** set in `src/app.ts`; add every new open route there —
  which is why the public unsubscribe is the *fixed* path `/v1/unsubscribe`, not a parameterized one).
  Every other `/v1` route needs a JWT, and `/v1/users` also needs
  `admin` (`requireRole`). Access tokens are HS256 (`jose`, `JWT_SECRET`) minted/verified in
  `shared/auth`; refresh tokens are **opaque + stored hashed** (`refresh_tokens`, revocable, rotated on
  refresh); passwords are **argon2id** (`@node-rs/argon2`) behind a `PasswordHasher` interface. The
  **only** non-JWT credential is the Postmark webhook's HTTP Basic-Auth (`/webhooks/postmark`, outside
  `/v1`).
- **Password reset + magic-link are email one-time tokens** ([ADR-013](docs/adrs/ADR-013-authentication-user-accounts.md)
  / [ADR-014](docs/adrs/ADR-014-passwordless-magic-link-login.md)). Both request endpoints are
  **non-enumerating** (always `200 {"status":"accepted"}`, equivalent work either way — same posture as
  the login timing fix, which now verifies a dummy argon2id digest on the unknown-email path). One
  generic store backs both: `one_time_tokens` + `OneTimeTokenRepository` with a `purpose`
  (`password-reset` | `magic-link`), hashed-at-rest, single-use, TTL-indexed — **don't** split it into
  two collections. Opaque tokens all mint/hash through `newOpaqueToken()` / `hashOpaqueToken()`
  (`shared/auth`, generalized from the old refresh-token helpers). Reset revokes all sessions
  (`RefreshTokenRepository.deleteAllForUser`); magic-link consume reuses login's exported
  `issueSession(...)` so both session types are identical. Account mail is sent by `AccountMailer` from
  `SYSTEM_EMAIL_FROM_ADDRESS`; the link vs. raw-token presentation is gated by `EMAIL_LINK_ENABLED`.
- **Public unsubscribe is a stateless-HMAC token endpoint, and unsubscribe ≠ suppression**
  ([ADR-015](docs/adrs/ADR-015-public-token-unsubscribe.md)). The subscriber-facing `GET`/`POST
  /v1/unsubscribe` (open; in `OPEN_V1_PATHS`) is authenticated by an **HMAC token bound to
  `(newsletterId, subscriptionId)`** — `unsubscribeToken()` / `verifyUnsubscribeToken()` in `shared/auth`,
  secret `UNSUBSCRIBE_TOKEN_SECRET` (**falls back to `JWT_SECRET`**). It's **derived, not stored** —
  long-lived + idempotent by design, so **don't** route it through the expiring, single-use
  `one_time_tokens` store, and there's **no** new column/collection/index. The `PublicUnsubscribe` use
  case is non-revealing (forged token → 400; valid-but-missing row → quiet success) and reuses the
  domain `subscription.unsubscribe(now)`. It flips **per-newsletter status only — it does NOT add to the
  global `deliverability` suppression list** (that's hard-bounce/complaint territory; keep them
  separate). Every campaign send emits a **per-recipient** `List-Unsubscribe` + `List-Unsubscribe-Post`
  (RFC 8058 one-click) header, built from `BASE_URL` (the API's own public origin; unset → headers
  omitted) — carried on the `email` port's per-recipient `EmailRecipient.headers`, mapped to the Postmark
  Bulk per-message `Headers`. The operator JWT endpoint
  (`.../subscriptions/{id}/unsubscribe`) is kept as-is — different caller.
- **The email port carries a business `category`, not a Postmark stream.** `BulkMessage.category` is
  `'broadcast' | 'transactional'` (campaigns → broadcast; subscribe confirmations + account mail →
  transactional). The Postmark adapter maps it to both the message stream **and** the signing token:
  broadcast uses `POSTMARK_SERVER_TOKEN`, transactional uses `POSTMARK_TRANSACTIONAL_SERVER_TOKEN`
  (which **falls back** to the broadcast token when unset — a single-server setup is unchanged). Don't
  reintroduce a raw `messageStream` field on the port.
- **Postmark wire format** (request/response, webhook schema) is implemented in
  `src/shared/email/postmark-delivery-gateway.ts` and `src/campaigns/presentation/webhook-routes.ts` —
  treat that code (or live docs) as the source of truth, not memory, before restating a Postmark fact
  in docs or code. Two facts worth not re-getting-wrong: the Bulk API (`POST /email/bulk`) is
  asynchronous with no per-call recipient cap (only a 50 MB payload ceiling), and webhook auth is
  HTTP Basic, not HMAC.
