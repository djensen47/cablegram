# ADR-013: Authentication & User Accounts

## Status

Accepted — 2026-07-22. **Implemented** — 2026-07-23 (the `accounts` component, JWT auth middleware,
and first-run setup). This ADR was updated on implementation: the original "API keys stay for service
callers" position was **reversed** — JWT now replaces all `/v1` authentication.

## Context

Earlier ADRs drifted into treating cablegram as pure machine-to-machine with a single static account
key — an over-reading of "headless / API-only" (ADR-004) and a conflation of *tenancy* with the *user
model* (ADR-010). Both are corrected in place. The reality:

- **Headless ≠ no user auth.** cablegram ships no UI, but a UI (build-your-own, or first-party later)
  will consume it, and **authentication is part of the API surface**, not the UI's private concern.
- **Single-tenant ≠ single-user.** One organization, but with **multiple users** (admins, managers).
  Tenancy is a different axis from the user model.

So cablegram needs a real authentication and user-account model as part of its API. When this was
built, the one open question — whether any non-human/service caller of `/v1` still existed — was
resolved: removing scheduled campaigns (ADR-009 Phase 1) deleted `dispatch-due`, the last machine
caller, so **every `/v1` caller is now a human with a JWT**. That settled the reversal below.

## Decision

### cablegram owns user accounts

- A **`User`** is a first-class domain concept in its own component, `accounts`: id, email (unique,
  normalized), password hash, **role**, timestamps. Not a tenant, not a subscriber — an operator of
  the single-tenant instance.
- **Roles:** `admin` and `manager` (a closed but extensible set). `admin` manages users and
  everything; `manager` manages newsletters/campaigns but **not** users. Authorization is role-based.
- **First-user bootstrap:** on a fresh instance (no users yet), a one-time open `POST /v1/setup`
  creates the first user as **`admin`**. It returns 409 once any user exists; thereafter admins
  create other users via `POST /v1/users`.

### Authentication = JWT (and only JWT)

- Human users authenticate with **email + password** (hashed with **argon2id** via `@node-rs/argon2`,
  behind a `PasswordHasher` interface) and receive:
  - a short-lived **access JWT** (HS256, signed with `JWT_SECRET`; `sub` = user id, `role` claim),
    issued/verified through `shared/auth` (the `jose` library);
  - an opaque **refresh token** — only its SHA-256 hash is stored (`refresh_tokens` collection), so
    it is genuinely **revocable**. Refresh **rotates** it (single-use); logout deletes it.
- Endpoints: `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout` (all open);
  `POST /v1/setup` (open, one-time). Everything else under `/v1` requires a valid access token via
  the `jwtAuth` middleware (`shared/http`), which sets `{ userId, role }` on the request; `requireRole`
  guards admin-only routes (`/v1/users`).

### There is no API key

- **JWT replaces the static API key entirely.** `apiKeyAuth` and the `API_KEYS` config are removed;
  the OpenAPI security scheme is `BearerAuth` (HTTP bearer, JWT). This **reverses** the original
  ADR's "API keys stay for service callers" — with `dispatch-due` gone there is no non-human `/v1`
  caller, so a single credential model (user JWT) is simpler and strictly safer. A future service
  integration would authenticate as a user account, not via a static key.
- **The sole exception** is the Postmark webhook (`/webhooks/postmark`), which is mounted outside
  `/v1` and keeps its own **HTTP Basic-Auth** (`POSTMARK_WEBHOOK_SECRET`) — Postmark offers no
  signing, and the webhook carries no user identity (ADR-008).

### What this does NOT change

- **Still single-tenant** (ADR-010): users live within the one org; no tenant/account id on entities.
- **Still headless** (ADR-004): auth is API endpoints, not a UI.

## Consequences

- A new `accounts` component (User + refresh-token aggregates, repositories, and the
  setup/login/refresh/logout/create-user/list use cases); a `shared/auth` leaf holding the JWT
  issue/verify seam and the opaque refresh-token helpers; `jwtAuth` + `requireRole` middleware in
  `shared/http`; config gains `JWT_SECRET` + access/refresh TTLs and loses `API_KEYS`.
- New collections: `users` (unique `email` index) and `refresh_tokens` (TTL index on `expiresAt`),
  both created by `ensureIndexes` (ADR-012 — the app owns index creation).
- Password storage and JWT signing are security-sensitive surfaces: `JWT_SECRET` must be a long
  random string (config enforces ≥32 chars), access tokens are short-lived, and refresh tokens are
  hashed-at-rest and rotated. **Password reset (email-based) is deferred** to a follow-up.
- Corrects the earlier drift: ADR-004 and ADR-010 no longer imply "no users."

## Related

- ADR-004 — Headless (auth is part of the API surface, not excluded by "no UI")
- ADR-010 — Single-tenant (multi-user *within* the one tenant; tenancy ≠ user model)
- ADR-008 — Email delivery (the Postmark webhook's Basic-Auth is the one non-JWT credential)
- ADR-009 — Deployment (removing `dispatch-due` left no service caller, settling JWT-only)
- ADR-001/002/005 — the `accounts` component follows the same layering/facade/boundary rules
- ADR-006 — HTTP delivery (auth middleware + endpoints)
