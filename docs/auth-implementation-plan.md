# Auth implementation — next-session plan/prompt

> **Ephemeral.** This is a working prompt for the session that implements authentication. Delete it
> once the work lands and [ADR-013](adrs/ADR-013-authentication-user-accounts.md) is marked
> implemented. The *decision* lives in ADR-013; this is the *how*.

## Goal

Add cablegram's own **user accounts + authentication** as part of the API surface. Single-tenant,
**multi-user**. First user becomes `admin`. Human login = **JWT**. Keep the existing API-key auth for
service/machine callers.

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
  context) and a `requireRole('admin')` guard. Keep `apiKeyAuth` for service callers.

### 3. Route protection policy
- Decide per-route which credential(s) are accepted. Sensible default: `/v1/users` and admin actions
  = JWT + `admin`; the newsletter/campaign/etc. `/v1` routes = **JWT (any role) OR API key** (so both
  a UI user and a service caller work). Document the matrix.

### 4. First-run / setup flow
- If `countAll()===0`, allow creating the first user (→ `admin`) without auth (a one-time setup
  endpoint, e.g. `POST /v1/setup`, that 409s once any user exists). After that, user creation is
  admin-only.

## Decisions to make while building (don't silently assume — surface them)
- Opaque+stored refresh tokens vs refresh JWT (recommend opaque+stored for revocation).
- KDF: argon2id (recommend) vs bcrypt.
- Password reset flow (email-based) — likely a follow-up, not v1; note it.
- Whether API keys eventually become "service users" — out of scope now.

## Tests
- Unit (in-memory repos + fake hasher): first-user-becomes-admin, login success/failure, role guard
  (manager blocked from `/v1/users`), token verify/expiry, setup-endpoint 409-after-bootstrap.
- Integration (Mongo): `MongoUserRepository` contract incl. the unique-email index rejection.
- Middleware: missing/invalid/expired JWT → 401; wrong role → 403; API-key path still works.

## When done
- Update `CLAUDE.md` (replace the "auth is unfinished" gotcha with the real auth rules).
- Flip ADR-013 Status to implemented; update the README index row.
- Delete this file.
