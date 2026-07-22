# ADR-013: Authentication & User Accounts

## Status

Accepted — 2026-07-22. **Decision made; not yet implemented** — see the working plan in
[`docs/auth-implementation-plan.md`](../auth-implementation-plan.md) for the next session.

## Context

Earlier ADRs drifted into treating cablegram as pure machine-to-machine with a single static account
key — an over-reading of "headless / API-only" (ADR-004) and a conflation of *tenancy* with the *user
model* (ADR-010). Both are corrected in place. The reality:

- **Headless ≠ no user auth.** cablegram ships no UI, but a UI (build-your-own, or first-party later)
  will consume it, and **authentication is part of the API surface**, not the UI's private concern.
- **Single-tenant ≠ single-user.** One organization, but with **multiple users** (admins, managers).
  Tenancy is a different axis from the user model.

So cablegram needs a real authentication and user-account model as part of its API. This ADR records
that decision; implementation is deferred (planned separately).

## Decision

### cablegram owns user accounts

- A **`User`** is a first-class domain concept (its own bounded context / component — e.g.
  `accounts`): id, email, password hash, **role**, timestamps. Not a tenant, not a subscriber — an
  operator of the single-tenant instance.
- **Roles:** at least `admin` and `manager` (extensible). `admin` manages users and everything;
  `manager` manages newsletters/campaigns but not users. Authorization is role-based.
- **First-user bootstrap:** on a fresh instance (no users yet), the first user created — during setup
  or first login — becomes the **`admin`**. Thereafter, admins create/manage other users.

### Authentication = JWT

- Human users authenticate with **email + password** (password hashed with a modern KDF — argon2id or
  bcrypt) and receive a **JWT access token** (short-lived), plus a **refresh token** for renewal.
  Login / refresh / logout are API endpoints.
- Route protection: a JWT-verifying middleware establishes the current user + role; role guards gate
  admin-only routes.

### Relationship to the existing API-key auth

- The current **API-key** middleware (ADR-004/010) stays for **service / machine-to-machine** callers
  (integrations, a server-side BFF that holds the account key). **User JWT** is the path for
  **humans** (via a UI). Whether a given route accepts a key, a JWT, or either is decided per route in
  implementation. API keys are *not* replaced by JWT — they serve different callers.

### What this does NOT change

- **Still single-tenant** (ADR-010): users live within the one org; no tenant/account id on entities.
- **Still headless** (ADR-004): auth is API endpoints, not a UI.

## Consequences

- A new `accounts` component (User aggregate + repository + login/user use cases), a JWT
  issue/verify seam in `shared` (config gets a signing secret + token TTLs), and auth/role middleware
  in `shared/http`.
- Password storage and JWT signing are now security-sensitive surfaces — KDF choice, secret
  management, token lifetimes, and refresh-token revocation must be gotten right (covered in the plan).
- Corrects the earlier drift: ADR-004 and ADR-010 are amended so "headless" and "single-tenant" no
  longer imply "no users."

## Related

- ADR-004 — Headless (auth is part of the API surface, not excluded by "no UI")
- ADR-010 — Single-tenant (multi-user *within* the one tenant; tenancy ≠ user model)
- ADR-001/002/005 — the new `accounts` component follows the same layering/facade/boundary rules
- ADR-006 — HTTP delivery (auth middleware + endpoints)
- Working plan: `docs/auth-implementation-plan.md`
