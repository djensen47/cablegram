# ADR-010: Single-Tenant Model

## Status

Accepted — 2026-07-19.

## Context

MailChimp-shaped products are usually multi-tenant SaaS (many accounts share one deployment). That
choice is load-bearing: it puts a tenant/account id on **every** entity and forces **every**
repository query and API route to be tenant-scoped from day one. Retrofitting it later is expensive;
building it when unneeded is waste.

cablegram is **single-tenant**: one organization per deployment. That decision is recorded here
because its consequences ripple through the data model (ADR-012) and the API surface (ADR-004).

## Decision

- **One organization per deployment.** Entities carry **no tenant/account id**; repositories do
  **no** tenant scoping. There is a single logical owner of all data in a given deployment.
- **Tenant ≠ newsletter.** Single-tenant does *not* mean single-newsletter: one account runs many
  newsletters (ADR-011). A `newsletterId` is ordinary within-account domain data, not a tenant scope.
- **Single-tenant ≠ single-user.** One org — but that org has **multiple users** (e.g. admins,
  managers). Tenancy (how many *orgs* share the deployment) is a different axis from the *user model*
  (individuals within the org). "No tenant/account id on entities" means no *cross-org* scoping — it
  does **not** mean "no users." User accounts and authentication are their own decision
  ([ADR-013](ADR-013-authentication-user-accounts.md)), and single-tenancy does not preclude them.
- Running cablegram for multiple organizations means **multiple deployments** (separate databases,
  separate configs), not one shared instance partitioned by tenant.

## Consequences

- Simpler data model and queries — no tenant column, no per-query scoping, no cross-tenant leakage
  class of bugs.
- Simpler authorization at the *tenant* level — one org boundary per deployment. Within it, per-user
  roles/authorization are a separate concern (ADR-013), not a tenancy one.
- **Multi-tenancy would be a real migration, not a config flip**: it would add an account concept to
  every model, tenant scoping to every repository (ADR-012), and tenant context to every route
  (ADR-006). Recorded so that cost is known up front and not assumed cheap.
- Operating many organizations multiplies deployments/infra rather than sharing them — acceptable at
  the intended scale; revisit this ADR if fleet size makes per-org deployments impractical.

## Related

- ADR-004 — Headless (the API surface — including auth — serves external UIs)
- ADR-013 — Authentication & user accounts (multiple users *within* the single tenant)
- ADR-012 — Persistence (no tenant scoping in repositories)
- ADR-011 — Bounded contexts (entities carry no tenant id)
