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
- **Auth** is a single set of credentials / API keys for that organization — API-key auth on the HTTP
  surface (ADR-006), not per-tenant user accounts.
- Running cablegram for multiple organizations means **multiple deployments** (separate databases,
  separate configs), not one shared instance partitioned by tenant.

## Consequences

- Simpler data model and queries — no tenant column, no per-query scoping, no cross-tenant leakage
  class of bugs.
- Simpler authorization — one trust boundary per deployment.
- **Multi-tenancy would be a real migration, not a config flip**: it would add an account concept to
  every model, tenant scoping to every repository (ADR-012), and tenant context to every route
  (ADR-006). Recorded so that cost is known up front and not assumed cheap.
- Operating many organizations multiplies deployments/infra rather than sharing them — acceptable at
  the intended scale; revisit this ADR if fleet size makes per-org deployments impractical.

## Related

- ADR-004 — Headless / API-only (API-key auth, single trust boundary)
- ADR-012 — Persistence (no tenant scoping in repositories)
- ADR-011 — Bounded contexts (entities carry no tenant id)
