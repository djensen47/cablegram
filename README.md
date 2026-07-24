# cablegram

A **headless newsletter manager/sender** — a MailChimp-shaped capability exposed as an **HTTP JSON
API, no UI**. You bring the front end (or none); cablegram owns publications, subscribers, templates,
campaigns, and suppression, and sends through an ESP (Postmark) that owns the fan-out.

Stack: TypeScript · Hono · Inversify · MongoDB (native driver) · Postmark · deploys on Docker /
DigitalOcean Functions · **single-tenant, multi-user, multi-newsletter**.

> The *why* behind every choice lives in the [ADRs](docs/adrs/README.md); the terse operative rules
> live in [`CLAUDE.md`](CLAUDE.md). This README is the human starting point — read it first.

## Contents

- [What it is](#what-it-is)
- [How cablegram thinks (the domain model)](#how-cablegram-thinks-the-domain-model)
- [Quickstart](#quickstart)
- [Authentication](#authentication)
- [API walkthrough (end to end)](#api-walkthrough-end-to-end)
- [API reference](#api-reference)
- [Conventions every endpoint shares](#conventions-every-endpoint-shares)
- [Configuration](#configuration)
- [Gotchas worth knowing](#gotchas-worth-knowing)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Testing](#testing)
- [Deployment](#deployment)
- [Notes](#notes)

## What it is

cablegram gives you the moving parts of a newsletter platform as a plain JSON API:

- **Newsletters** — your publications, each with its own sender identity (from-name/email, reply-to,
  sending domain / DKIM).
- **Subscriptions** — who receives a given newsletter, with single or double opt-in, merge fields,
  and tags for segmenting.
- **Templates** — reusable, Handlebars-rendered message bodies (`{{firstName}}`, `{{weekOf}}`, …).
- **Campaigns** — a send: pick a newsletter, a template (or inline content), optionally a tag segment,
  then send now and read back per-recipient outcomes.
- **Deliverability** — a global suppression list (the deny-list) cablegram enforces on every send and
  keeps in sync from provider bounce/complaint events.
- **Accounts** — the operators of the instance (admins and managers), with JWT auth.

There is **no scheduling** in v1 — sending is on-demand (`POST /v1/campaigns/{id}/send`). There is
**no UI** — the OpenAPI contract at `GET /openapi.json` is the product surface.

## How cablegram thinks (the domain model)

A few ideas explain most of the API. Internalize these and the endpoints fall out naturally.

**Newsletters are publications; the tenant is the whole instance.** cablegram is *single-tenant* —
one organization owns the deployment — but *multi-newsletter* and *multi-user*. A `newsletterId` is
ordinary data identifying a publication, **not** a tenant boundary. One account, many newsletters,
many operators.

**Subscriptions are flat and per-newsletter — there is no cross-newsletter "Contact".** The same
email address subscribed to two newsletters is **two independent subscription records**. That
duplication is intentional: there is no global person/contact identity to reconcile. The *only* fact
tracked globally by address is **suppression**.

**Suppression is the one global, address-keyed truth.** The suppression list is a deny-list keyed by
email address across the whole instance. Every send passes **two gates**: a recipient must be
`subscribed` to that newsletter **and** not on the suppression list. Hard bounces and spam complaints
(reported by Postmark's webhook) add addresses to it automatically; you can also add/remove entries
directly.

**Campaigns are the integrator.** A campaign pulls together a newsletter (sender identity), its
subscribers (recipients), the suppression list (filter), and a template (rendering) to produce one
send. Its lifecycle is `draft → sending → sent | failed`.

**Postmark owns the fan-out.** cablegram resolves + filters + renders recipients, then makes **one**
asynchronous Postmark *Bulk* call. The immediate response is a submission acknowledgement (a request
id), not per-recipient results — those arrive later via the webhook and are recorded on the campaign's
**send record**. There is no queue, worker, or cursor in cablegram itself.

## Quickstart

Requires **Node 24+** (`.nvmrc`) and MongoDB. A plain standalone `mongod` is enough — cablegram does
only single-document, no-transaction writes, so no replica set is needed (ADR-012);
[Atlas](https://www.mongodb.com/atlas) works too.

```bash
npm install
cp .env.example .env        # then edit values (JWT_SECRET must be ≥32 chars)
npm run dev                 # tsx watch, serves on $PORT (default 3000)

curl localhost:3000/health
# {"status":"ok","service":"cablegram"}
```

The generated API contract is always available (and open) at `GET /openapi.json`.

## Authentication

`/v1` is protected by a per-user **Bearer access token (JWT)** — there is no API key. Users have a
**role**: `admin` (manages users and everything) or `manager` (manages newsletters/campaigns, but not
users).

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/setup` | **open, one-time** | Create the first user (becomes `admin`). 409 once any user exists. |
| `POST /v1/auth/login` | open | Email + password → access + refresh tokens. |
| `POST /v1/auth/refresh` | open | Exchange a refresh token for a new session (rotates it). |
| `POST /v1/auth/logout` | open | Revoke a refresh token. |
| `POST /v1/auth/password-reset` · `POST /v1/auth/password-reset/confirm` | open | Email-based password reset (request → confirm). |
| `POST /v1/auth/magic-link` · `POST /v1/auth/magic-link/consume` | open | Passwordless login (request → consume). |
| `GET /v1/unsubscribe` · `POST /v1/unsubscribe` | **open, token** | Public unsubscribe: the query `token` (HMAC-bound to the newsletter + subscription) authenticates — no JWT. `GET` is the body link; `POST` is the RFC 8058 one-click target. |
| `POST /v1/users` · `GET /v1/users` · `GET /v1/users/{id}` | JWT + **admin** | Manage operators. |
| everything else under `/v1` | JWT (any role) | The domain API. |
| `POST /webhooks/postmark` | **HTTP Basic-Auth** | Provider events — the sole non-JWT credential; mounted outside `/v1`. |

- **Access token**: short-lived HS256 JWT (default 15m), sent as `Authorization: Bearer <token>`.
- **Refresh token**: opaque and **stored hashed** (revocable), rotated on every refresh, default 30d.
  Use it at `/v1/auth/refresh` to get a fresh access token; `/v1/auth/logout` revokes it.
- Passwords are hashed with **argon2id**. Bootstrap the first admin with `POST /v1/setup`, then
  admins create teammates with `POST /v1/users`. There is no public self-registration.
- **Password reset & magic-link** both work by email: the request endpoint takes an address, always
  returns `200 {"status":"accepted"}` (it never reveals whether the account exists), and — if it does
  — emails a single-use, expiring **opaque token** (only its hash is stored). The confirm/consume
  endpoint takes that token: reset sets a new password **and revokes all existing sessions**;
  magic-link issues a normal session identical to a password login. Token lifetimes default to 1h
  (reset) and 15m (magic-link). The emailed **token** is what matters; whether the email presents it
  as a clickable link or as a raw token depends on `EMAIL_LINK_ENABLED` (see Configuration) — cablegram
  is headless, so with no front-end configured the email carries the token plus the API path to post it
  to. Account emails are sent as **transactional** mail from the configured `SYSTEM_EMAIL_FROM_ADDRESS`.
- **Public unsubscribe** (`/v1/unsubscribe`) is open but **token-authenticated**: the link carries
  `newsletterId`, `subscriptionId` and a stateless `HMAC-SHA256` **token** bound to that pair, so it
  needs no login yet can't be forged or replayed against another newsletter. It is long-lived (a link in
  an old email still works) and idempotent, and it flips **per-newsletter status only** — it does *not*
  add the address to the global suppression list. Every campaign send emits a per-recipient
  `List-Unsubscribe` + `List-Unsubscribe-Post` header pointing here (RFC 8058 one-click), built from
  `BASE_URL`. See [ADR-015](docs/adrs/ADR-015-public-token-unsubscribe.md).

```bash
# First-run bootstrap (open, one-time):
curl -X POST localhost:3000/v1/setup -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"a-strong-password"}'

# Log in and capture a Bearer token for the rest of the session:
TOKEN=$(curl -sX POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"a-strong-password"}' | jq -r .accessToken)

curl -H "authorization: Bearer $TOKEN" localhost:3000/v1/newsletters
```

## API walkthrough (end to end)

The full journey — publication → template → subscriber → campaign → send → outcomes — assuming
`$TOKEN` from above. `A="authorization: Bearer $TOKEN"` and `J='content-type: application/json'` keep
the commands short. All create/list responses are DTOs (never internal entities), and lists use the
`{ data, meta: { nextCursor } }` envelope.

```bash
A="authorization: Bearer $TOKEN"; J='content-type: application/json'

# 1. Create a newsletter (its sender identity).
NL=$(curl -sX POST localhost:3000/v1/newsletters -H "$A" -H "$J" -d '{
  "name": "The Weekly Dispatch",
  "fromName": "Dispatch Editors",
  "fromEmail": "editors@dispatch.example",
  "replyTo": "replies@dispatch.example"
}' | jq -r .id)

# 2. Create a reusable template (Handlebars in subject + body).
TPL=$(curl -sX POST localhost:3000/v1/templates -H "$A" -H "$J" -d '{
  "name": "Weekly digest",
  "subject": "Your {{weekOf}} digest",
  "bodyHtml": "<p>Hi {{firstName}}, here is your digest.</p>"
}' | jq -r .id)

# 3. Add a subscriber. doubleOptIn defaults to true (sends a confirmation);
#    pass false for single opt-in (immediately subscribed). mergeFields feed the template.
curl -sX POST "localhost:3000/v1/newsletters/$NL/subscriptions" -H "$A" -H "$J" -d '{
  "email": "reader@dispatch.example",
  "doubleOptIn": false,
  "mergeFields": { "firstName": "Sam" },
  "tags": ["vip"]
}'

# 4. Create a campaign referencing the newsletter + template.
#    (Alternatively provide inline "subject" + "bodyHtml" instead of a templateId.)
#    "segmentTags" is optional — restrict recipients to subscribers carrying those tags.
CMP=$(curl -sX POST localhost:3000/v1/campaigns -H "$A" -H "$J" -d "{
  \"newsletterId\": \"$NL\",
  \"name\": \"March Dispatch\",
  \"templateId\": \"$TPL\"
}" | jq -r .id)

# 5. Send it now. Recipients are resolved (subscribed AND not suppressed),
#    rendered, and handed to Postmark in one Bulk call. Returns a send record.
curl -sX POST "localhost:3000/v1/campaigns/$CMP/send" -H "$A"

# 6. Read the send record back — per-recipient outcomes + aggregate stats,
#    updated as Postmark webhook events arrive.
curl -s "localhost:3000/v1/campaigns/$CMP/send" -H "$A" | jq '.stats'
# { "recipients": 1, "accepted": 1, "rejected": 0, "delivered": 0, "bounced": 0, "complained": 0 }

# 7. Manage the suppression list directly (hard bounces / complaints add to it automatically).
curl -sX POST localhost:3000/v1/suppressions -H "$A" -H "$J" \
  -d '{ "address": "bounced@dispatch.example", "reason": "manual-junk" }'
```

Provider events arrive out of band at `POST /webhooks/postmark` (Basic-Auth, not `/v1`): cablegram
normalizes each event, updates the send record, and suppresses hard-bounce / spam-complaint addresses.

## API reference

All paths are under `/v1` (JWT required) except where noted. `GET /openapi.json` is the authoritative,
always-current contract — this table is the map.

### Auth & users (`accounts`)
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/setup` | open, once | First user → `admin`; 409 afterwards |
| POST | `/v1/auth/login` | open | → access + refresh tokens |
| POST | `/v1/auth/refresh` | open | Rotates the refresh token |
| POST | `/v1/auth/logout` | open | Revokes a refresh token (idempotent, 204) |
| POST | `/v1/auth/password-reset` | open | Request a reset email (always 200; non-enumerating) |
| POST | `/v1/auth/password-reset/confirm` | open | Token + new password → sets password, revokes sessions (204) |
| POST | `/v1/auth/magic-link` | open | Request a login email (always 200; non-enumerating) |
| POST | `/v1/auth/magic-link/consume` | open | Token → a normal session (access + refresh) |
| POST · GET | `/v1/users` | admin | Create / list operators |
| GET | `/v1/users/{id}` | admin | Get one |

### Newsletters
| Method | Path | Notes |
|---|---|---|
| POST · GET | `/v1/newsletters` | Create / list |
| GET · PATCH · DELETE | `/v1/newsletters/{id}` | Get / update / delete |

### Subscriptions (nested under a newsletter)
| Method | Path | Notes |
|---|---|---|
| POST · GET | `/v1/newsletters/{id}/subscriptions` | Subscribe / list (`?status=&tag=`) |
| POST | `/v1/newsletters/{id}/subscriptions/{subId}/confirm` | Confirm a pending (double opt-in) subscription |
| POST | `/v1/newsletters/{id}/subscriptions/{subId}/unsubscribe` | Unsubscribe (operator; JWT) |
| GET · POST | `/v1/unsubscribe?newsletterId=&subscriptionId=&token=` | **Public** unsubscribe — no JWT, the HMAC `token` authenticates (ADR-015). `GET` = body link (redirect or HTML confirmation); `POST` = RFC 8058 one-click (`List-Unsubscribe=One-Click`, returns 200) |

Statuses: `pending` · `subscribed` · `unsubscribed`.
Public unsubscribe flips per-newsletter status only — it does **not** add to the global suppression list.

### Templates
| Method | Path | Notes |
|---|---|---|
| POST · GET | `/v1/templates` | Create / list |
| GET · PATCH · DELETE | `/v1/templates/{id}` | Get / update / delete |

### Campaigns
| Method | Path | Notes |
|---|---|---|
| POST · GET | `/v1/campaigns` | Create / list (`?newsletterId=&status=`) |
| GET · PATCH · DELETE | `/v1/campaigns/{id}` | Get / update (only while not yet sent) / delete |
| POST | `/v1/campaigns/{id}/send` | Send now |
| GET | `/v1/campaigns/{id}/send` | Send record: per-recipient outcomes + stats |

Statuses: `draft` · `sending` · `sent` · `failed`.

### Suppressions (`deliverability`)
| Method | Path | Notes |
|---|---|---|
| POST · GET | `/v1/suppressions` | Add / list |
| GET · DELETE | `/v1/suppressions/{address}` | Check / remove |

Reasons: `hard-bounce` · `spam-complaint` · `manual-junk` · `global-opt-out`.

### Webhooks
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/webhooks/postmark` | HTTP Basic | Provider delivery/bounce/complaint events |

## Conventions every endpoint shares

- **Auth:** `Authorization: Bearer <access-token>` on all `/v1` routes (see [Authentication](#authentication)).
- **Errors:** a stable envelope — `{ "error": { "code", "message", "details?", "requestId?" } }`.
  Validation failures are `400 validation_error`; auth `401 unauthorized`; role `403 forbidden`;
  missing `404 not_found`; conflicts `409 conflict`.
- **Pagination:** list routes take `?limit=&cursor=` and return `{ "data": [...], "meta": { "nextCursor" } }`.
  `nextCursor` is `null` on the last page; pass it back as `cursor` for the next page. No offset/skip.
- **Idempotency:** mutating `POST` routes honor an optional `Idempotency-Key` header — a retried
  request with the same key replays the original response instead of acting twice; the same key with a
  different body is a `409`.
- **Request ids:** every response carries `X-Request-Id` (echoed if you send one) for log correlation.

## Configuration

All configuration is environment variables (no config files on disk). See [`.env.example`](.env.example).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | MongoDB connection string (db name in the path). Standalone `mongod` is fine. |
| `JWT_SECRET` | yes | — | HS256 signing secret for access tokens. **Must be ≥32 chars, long and random.** |
| `POSTMARK_SERVER_TOKEN` | yes | — | Postmark **broadcast** server token for the Bulk send API. |
| `POSTMARK_WEBHOOK_SECRET` | yes | — | Basic-Auth password guarding `POST /webhooks/postmark`. |
| `SYSTEM_EMAIL_FROM_ADDRESS` | yes | — | `From` address for account mail (reset / magic-link). Must be a Postmark-verified sender/domain. |
| `PORT` | no | `3000` | HTTP port. |
| `JWT_ACCESS_TTL_SECONDS` | no | `900` | Access-token lifetime (15m). |
| `JWT_REFRESH_TTL_SECONDS` | no | `2592000` | Refresh-token lifetime (30d). |
| `EMAIL_PROVIDER` | no | `postmark` | Email backend seam; only `postmark` today. |
| `POSTMARK_TRANSACTIONAL_SERVER_TOKEN` | no | *(= broadcast token)* | Separate token for **transactional** sends (account + confirmation mail). Falls back to `POSTMARK_SERVER_TOKEN`. |
| `SYSTEM_EMAIL_FROM_NAME` | no | `cablegram` | Display name for account mail. |
| `EMAIL_LINK_ENABLED` | no | `false` | If `true`, account emails link to the base URLs below (both then **required**); else they carry the raw token + API path. |
| `PASSWORD_RESET_URL_BASE` | if links on | — | Front-end base for the reset link; the token is appended as `?token=`. |
| `MAGIC_LINK_URL_BASE` | if links on | — | Front-end base for the magic-link; the token is appended as `?token=`. |
| `PASSWORD_RESET_TTL_SECONDS` | no | `3600` | Password-reset token lifetime (1h). |
| `MAGIC_LINK_TTL_SECONDS` | no | `900` | Magic-link token lifetime (15m). |
| `BASE_URL` | no | — | The API's **own** public origin (e.g. `https://api.example.com`). Needed to emit per-recipient `List-Unsubscribe` links on sends (ADR-015); unset → those headers are omitted. |
| `UNSUBSCRIBE_TOKEN_SECRET` | no | *(= `JWT_SECRET`)* | HMAC secret for the stateless unsubscribe token. Falls back to `JWT_SECRET`; set separately to decouple link validity from JWT-secret rotation. |
| `UNSUBSCRIBE_REDIRECT_ENABLED` | no | `false` | If `true`, the browser `GET` unsubscribe redirects to `UNSUBSCRIBE_REDIRECT_URL` (address appended as `?email=`); else it renders a generic HTML confirmation. |
| `UNSUBSCRIBE_REDIRECT_URL` | if redirect on | — | Landing page the unsubscribe `GET` redirects to on success. |

## Gotchas worth knowing

- **No cross-newsletter contact identity.** The same email in two newsletters is two independent
  subscriptions. Only *suppression* is global by address.
- **Suppression is enforced at send time, not in the mail adapter.** A campaign send filters against
  both gates (subscribed **and** not suppressed); cablegram owns its own authoritative suppression
  list rather than deferring to Postmark's.
- **The send response is an acknowledgement, not delivery.** One async Postmark Bulk call returns a
  request id; per-recipient results land later via the webhook and update the send record.
- **The Postmark webhook is Basic-Auth, not signed.** Postmark offers no HMAC/signature — the receiver
  checks `POSTMARK_WEBHOOK_SECRET` as a Basic-Auth password, which is why it sits outside `/v1`.
- **No scheduling in v1.** Sending is on-demand only; there is no `scheduled` status and no timer.

## Project layout

```
src/
  shared/        technical modules — leaves (config, auth, email, ids, clock, di, http, persistence)
  app.ts         Hono app assembly (route mounting + the JWT gate)
  server.ts      Node entrypoint (Docker / App Platform)
  function.ts    DigitalOcean Functions entrypoint
  <component>/   domain components (ADR-011):
                 newsletters · subscriptions · deliverability · templates · campaigns · accounts
```

Each component and shared module is fronted by an `index.ts` **facade**; every layer nests inside its
component (`domain/` → `application/` → `infrastructure/`/`presentation/`, Clean Architecture). Imports
cross boundaries only through facades, and only inward — enforced by `eslint-plugin-boundaries` (the
lint config *is* the encoded architecture). The full rationale is in the
[ADRs](docs/adrs/README.md); the operative rules are in [`CLAUDE.md`](CLAUDE.md).

## Scripts

| script | does |
|---|---|
| `npm run dev` | watch-mode server (`tsx`) |
| `npm run build` / `start` | compile to `dist/` / run compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint + **boundary enforcement** (ADR-005) |
| `npm test` | Vitest (fast, in-memory repositories, no DB) |
| `npm run test:integration` | Vitest repository contract tests against a real `mongod` |

**Green gate before a PR:** `npm run typecheck && npm run lint && npm test` (add `test:integration`
for persistence changes). See [`docs/testing.md`](docs/testing.md) for the two-suite split.

## Testing

- **`npm test`** — use cases + routes, with each repository DI-rebound to an `InMemory<X>Repository`
  double (ADR-003). Sub-second, no database, no network; this is CI's gate.
- **`npm run test:integration`** — each `Mongo<X>Repository` against a real standalone `mongod`
  (`mongodb-memory-server`), asserting the same contract the in-memory doubles are held to.

Full details, and what's not yet covered (a wired end-to-end suite is the top gap), are in
[`docs/testing.md`](docs/testing.md).

## Deployment

Docker is the shipped, guaranteed target; DigitalOcean Functions is a best-effort second target. Both
entrypoints share every line of business logic; Mongo is the only durable state (pooled at module
scope), and the app creates its own indexes at startup. See [`docs/deployment.md`](docs/deployment.md)
for build details and the Functions caveats.

```bash
docker build -t cablegram .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="mongodb://host.docker.internal:27017/cablegram" \
  -e JWT_SECRET="change-me-to-a-long-random-secret-at-least-32-chars" \
  -e POSTMARK_SERVER_TOKEN="pm-server-token" \
  -e POSTMARK_WEBHOOK_SECRET="change-me" \
  cablegram
# (not `--env-file .env` — Docker's env-file loader doesn't strip the quotes in
# .env.example's values, unlike Node's process.loadEnvFile used by `npm run dev`)
```

CI (`.github/workflows/ci.yml`) runs `typecheck`/`lint`/`test` on every PR.

## Notes

- `npm audit` reports advisories in **dev-only** tooling (the eslint-plugin-boundaries handlebars
  chain; the vitest/vite/esbuild dev-server chain). None are in the runtime dependencies and none ship
  to production, so they are not force-fixed (that would break linter/test majors).
- DigitalOcean Functions' exact request/response contract is confirmed against DO docs at deploy;
  `src/function.ts` bridges it and is marked accordingly (ADR-009).
