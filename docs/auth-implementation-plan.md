# Auth implementation — next-session plan/prompt

> **Ephemeral.** This is a working prompt for the session that implements authentication. Delete it
> once the work lands and [ADR-013](adrs/ADR-013-authentication-user-accounts.md) is marked
> implemented. The *decision* lives in ADR-013; this is the *how*.

## Goal

Add cablegram's own **user accounts + authentication** as part of the API surface. Single-tenant,
**multi-user**. First user becomes `admin`. Human login = **JWT**. **JWT replaces ALL authentication —
the static API key is removed entirely**; the Postmark webhook's HTTP Basic-Auth is the sole
exception. (This reverses ADR-013's "API keys stay for service callers" — the ADR text and CLAUDE.md's
auth rules must be **rewritten**, not just flipped to "implemented".)

> **Handoff note (2026-07-22).** The decisions below were settled in a prior session — see "Locked
> decisions". Prerequisite PR #16 (scheduled-campaigns removal) landed first, which deleted
> `dispatch-due`, the main non-human `/v1` caller.

## Locked decisions (settle no further — build to these)

- **JWT replaces all auth; no API keys.** Remove `apiKeyAuth` from `/v1`, drop `API_KEYS` from config,
  add `JWT_SECRET` + access/refresh TTLs. Bearer JWT is the only `/v1` credential; OpenAPI security
  scheme becomes Bearer JWT.
- **Refresh tokens: opaque + stored (revocable).** Persist only a SHA-256 hash in a `refresh_tokens`
  collection; enables real logout/rotation. Needs a `RefreshTokenRepository` (Mongo + InMemory).
- **JWT library: `jose`** (ESM-native; HS256 access tokens).
- **Password KDF: argon2id via `@node-rs/argon2`** (prebuilt binaries, no compiler) behind the
  `PasswordHasher` interface; tests use a fake hasher.
- **Open question — ask the human first:** under JWT-only, is there any remaining automated/service
  caller of `/v1`? Removing `dispatch-due` deleted the main one. If yes → a service user account
  holding a refresh token; if no → every `/v1` caller is a human with a JWT.

## Ground rules (unchanged)

- Always a branch; never touch `main`. Verify green before pushing: `typecheck`, `lint` (incl.
  eslint-plugin-boundaries), `test` (unit), `test:integration`.
- Clean architecture + package-by-component (ADR-001/002/005): new component behind an `index.ts`
  facade, Clean layers inside, DI `ContainerModule` loaded at the composition root, interfaces in
  `application/`, Mongo impl + `InMemory*` double in `infrastructure/`.
- Persistence = native MongoDB driver (ADR-012), string `_id`, no transactions, indexes via
  `ensureIndexes`. DO NOT reintroduce Prisma.

## Scope

### 1. `accounts` component (`src/accounts/`)
- **Domain:** `User` aggregate — id, email (unique, normalized via `shared/email-address`),
  `passwordHash`, `role` (`admin` | `manager`), timestamps. Invariant: **first user created on a
  fresh instance is `admin`**. Value objects / domain errors as needed. Roles extensible.
- **Application:** `UserRepository` (findByEmail, findById, create, update, list, `countAll` for the
  first-user check). Use cases: `RegisterInitialAdmin` (only when `countAll()===0`), `CreateUser`
  (admin-only), `Login` (email+password → tokens), `RefreshSession`, `Logout`, `ListUsers`,
  optionally `ChangePassword`. A `PasswordHasher` interface + `RefreshTokenRepository` (or store) if
  refresh tokens are server-side/revocable.
- **Infrastructure:** `MongoUserRepository` + `InMemoryUserRepository`; `Argon2PasswordHasher` (or
  bcrypt) behind the interface; `ContainerModule`. Add the `users` collection + a **unique index on
  email** to `ensureIndexes`.
- **Presentation:** `/v1/auth/login`, `/v1/auth/refresh`, `/v1/auth/logout`; `/v1/users` CRUD
  (admin-only). zod-OpenAPI DTOs, never leak the User entity / passwordHash.

### 2. JWT + auth middleware (`shared`)
- Config (`shared/config`): `JWT_SECRET`, access-token TTL (e.g. 15m), refresh-token TTL (e.g. 30d).
- Issue an **access JWT** (HS256, claims: sub=userId, role) + a **refresh token** (opaque + stored so
  it can be revoked, or a signed refresh JWT — decide; opaque+stored is safer for logout/revocation).
- `shared/http`: a `jwtAuth` middleware (verify access token → set `{ userId, role }` on the Hono
  context) and a `requireRole('admin')` guard. **Remove `apiKeyAuth`** and the `API_KEYS` config.

### 3. Route protection policy
- All `/v1` routes require a **JWT** (no API key). `/v1/users` + admin actions = JWT + `admin`;
  newsletter/campaign/etc. routes = JWT (any role). `/v1/auth/login|refresh` and `/v1/setup` are open;
  `/webhooks/postmark` keeps Basic-Auth. Document the matrix.

### 4. First-run / setup flow
- If `countAll()===0`, allow creating the first user (→ `admin`) without auth (a one-time setup
  endpoint, e.g. `POST /v1/setup`, that 409s once any user exists). After that, user creation is
  admin-only.

## Decisions — resolved (see "Locked decisions")
- Refresh tokens → **opaque + stored**. KDF → **argon2id (`@node-rs/argon2`)**. JWT lib → **`jose`**.
- Password reset flow (email-based) — **deferred** (follow-up, not v1); note it in the docs.
- API keys → **removed entirely** (not "kept for service callers"). Any service caller authenticates
  as a user — see the open question in "Locked decisions".

## Tests
- Unit (in-memory repos + fake hasher): first-user-becomes-admin, login success/failure, role guard
  (manager blocked from `/v1/users`), token verify/expiry, setup-endpoint 409-after-bootstrap.
- Integration (Mongo): `MongoUserRepository` contract incl. the unique-email index rejection.
- Middleware: missing/invalid/expired JWT → 401; wrong role → 403; API-key path still works.

## When done
- Update `CLAUDE.md` (replace the "auth is unfinished" gotcha with the real auth rules).
- Flip ADR-013 Status to implemented; update the README index row.
- Delete this file.
