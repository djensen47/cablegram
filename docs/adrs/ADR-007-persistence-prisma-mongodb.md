# ADR-007: Persistence — Prisma + MongoDB, DB-Portable

> ⛔ **SUPERSEDED — HISTORICAL ONLY.** cablegram uses the **native MongoDB driver**, not Prisma — see
> [ADR-012](ADR-012-persistence-mongodb-native-driver.md). Do **not** reintroduce Prisma or act on the
> Prisma-specific mechanics below. (The *portable-subset* rationale still holds; ADR-012 preserves it
> and is the current state.)

## Status

**Superseded by [ADR-012](ADR-012-persistence-mongodb-native-driver.md)** — 2026-07-20. Originally
accepted 2026-07-19.

> Prisma was swapped for the official MongoDB native driver behind the **same** repository interfaces
> (that was always the point of putting it behind a seam). The portability discipline below still
> holds verbatim — string `_id`s, id-reference relations, no embedded documents, no transactions — so
> this ADR remains the reference for *why* the portable subset exists. Only the implementation
> (Prisma → `mongodb` driver) and two of its consequences changed: index sync is now an in-app
> `ensureIndexes` bootstrap rather than `prisma db push`, and **no replica set is required** (ADR-012
> confirmed the standalone topology empirically). Read ADR-012 for the current state.

## Context

cablegram persists newsletters, subscriptions, campaigns, templates, and the deliverability
suppression list. Two things are true at once and must be reconciled:

1. **We deploy on MongoDB** — a deliberate choice for this project.
2. **The code should stay DB-agnostic** — genuine portability, so Postgres (or another store) remains
   a real swap, not a rewrite.

These pull in opposite directions. MongoDB via Prisma supports document-shaped features (embedded
documents, `@db.ObjectId`, no cross-model joins, replica-set-only transactions) that, if used freely,
would weld the code to Mongo. The DB-agnostic goal means we must *decline* the parts of Mongo that
don't have a portable equivalent.

Clean Architecture already gives us the seam: repository **interfaces live in `application/`**
(ADR-001), and their implementations live in `infrastructure/`. Prisma is an implementation detail
behind those interfaces.

## Decision

### Prisma is the ORM, behind repository gateways

- **Prisma** is the persistence implementation in `infrastructure/`. Use cases depend only on
  repository **interfaces** in `application/` (`SubscriptionRepository`, `CampaignRepository`, …).
  Prisma types **never** cross into `application/` or `domain/`, and never onto the wire (ADR-004).

### Portability discipline (the load-bearing part)

- Keep the Prisma schema to a **portable subset**: model relations via **explicit foreign-key-style
  id references**, not embedded documents or Mongo-only constructs, so the same logical schema maps
  onto a relational store.
- **No cross-store-incompatible features** in application logic: no reliance on Mongo aggregation
  pipelines, no embedded-document querying, no `ObjectId`-specific behavior leaking past the
  repository. Where an id type is needed in the domain, use an app-owned id value object (ADR-011
  `shared/ids`), not a raw `ObjectId`.
- **Transactions**: MongoDB requires a replica set for multi-document transactions. Design use cases
  to **minimize cross-document transactional needs**; where atomicity matters, keep it within a
  single document/model. Do not assume ambient multi-model transactions are free.
- The **repository is the swap seam.** Swapping to Postgres means writing new `Prisma*Repository`
  implementations (and a relational schema) and rebinding tokens (ADR-003) — no change to use cases.

## Consequences

- Portability is real, not aspirational: business logic never names Mongo, and the swap surface is a
  known, finite set of repository implementations.
- We pay for it by **forgoing Mongo-native ergonomics** (embedded docs, rich aggregation) — a
  lowest-common-denominator schema. Accepted, per the DB-agnostic goal.
- Prisma's MongoDB connector needs a **replica set** for transactions; local/dev Mongo must be
  configured accordingly, and use cases are written to not lean on wide transactions.
- If the DB-agnostic goal is ever abandoned, this ADR is where to relax the portability rules — at
  which point Mongo-specific features become fair game.

## Related

- ADR-001 — Clean Architecture (repository interfaces in `application/`)
- ADR-003 — Dependency Injection (binding/rebinding repository implementations)
- ADR-011 — Bounded contexts (which components own which repositories)
