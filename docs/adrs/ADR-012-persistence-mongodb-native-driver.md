# ADR-012: Persistence — MongoDB Native Driver behind the same repository seam

## Status

Accepted — 2026-07-20. Supersedes [ADR-007](ADR-007-persistence-prisma-mongodb.md).

## Context

[ADR-007](ADR-007-persistence-prisma-mongodb.md) chose **Prisma** as the persistence implementation
on MongoDB, deliberately confined to a portable subset (app-owned string ids mapped to `_id`,
id-reference relations, no embedded documents, no reliance on transactions). Crucially, it put Prisma
**behind repository interfaces** in each component's `application/` — so the ORM was always a swappable
implementation detail, never a commitment in the domain.

That confinement made Prisma a poor fit in practice. Prisma is a SQL-first ORM; on MongoDB it charges
for things we don't use and forces friction we don't want:

- **A codegen step.** `prisma generate` must run before typecheck/build/CI, and its output (the
  generated client) has to be threaded through the Docker build and copied between stages.
- **A native query-engine binary.** The Rust engine is platform-specific — it needs `binaryTargets`
  pinning for the Debian runtime image, is tens of MB (material against DigitalOcean Functions' 48 MB
  action cap, ADR-009), and is exactly the kind of native dependency serverless build models handle
  worst.
- **`db push`, not migrations.** MongoDB has no Prisma migration files, so schema/index sync is an
  out-of-band `prisma db push` — another moving part, and a schema file whose only real job was
  declaring indexes.
- **A replica set for transactions.** Prisma's MongoDB connector requires a replica-set topology.
  ADR-007 accepted this — but cablegram writes only single documents and leans on **no** transactions,
  so the requirement bought nothing and constrained every environment (local, CI, prod) to a topology
  the app never actually needs.

Because the repository interfaces were the swap seam by design, none of this touches the domain — the
fix is to swap the implementation.

## Decision

### The official MongoDB Node.js driver (`mongodb`), behind the unchanged repository interfaces

- The persistence implementation in `infrastructure/` is now the **native `mongodb` driver**. Each
  repository (`MongoNewsletterRepository`, `MongoSubscriptionRepository`, … — the naming convention's
  `<Qualifier>Thing` form, ADR-003) talks to `db.collection(...)` directly, mapping documents to/from
  the domain aggregate exactly as the Prisma versions did.
- The repository **interfaces in `application/` are unchanged** — same signatures, return types, and
  semantics. Use cases, DTOs, presentation, and the DI structure are untouched; only the persistence
  binding in the composition root and the `infrastructure/` implementations changed.
- **One pooled `MongoClient`**, created at module scope in the composition root and reused across warm
  invocations (ADR-009), with a derived `Db` handle injected into every repository. Both are bound
  lazily so a container built only to rebind repositories in tests never opens a connection.
- **The app owns index creation.** With no `db push`, an `ensureIndexes(db)` bootstrap (in
  `shared/persistence`) creates every index the repositories rely on; it runs once at startup in both
  entrypoints (and in the integration-test setup). `createIndexes` is idempotent, so it is safe on
  every warm boot.

### What is kept (the portability discipline of ADR-007 still holds)

- App-owned **string ids stored as `_id`** (no `ObjectId`); the normalized address is the suppression
  `_id`.
- **Id-reference relations only** — no embedded documents, no Mongo-only query constructs past the
  repository. `Json`-shaped fields (`mergeFields`, `stats`, `outcomes`) are plain nested BSON;
  scalar lists (`tags`, `segmentTags`, `appliedEvents`) are arrays.
- **No transactions.** Every write is a single-document op. Pagination stays the id-ordered,
  exclusive-cursor sweep.
- **The repository is still the swap seam.** Swapping to another store means writing new repository
  implementations and rebinding tokens (ADR-003) — no change to use cases.

### No replica set required (confirmed)

Because every write is a single document and nothing uses transactions, cablegram needs **no replica
set**. This was verified empirically: the repository contract tests (`*.integration.test.ts`, 30
assertions covering create/find/update/delete, compound-unique rejection, idempotent upsert, and the
dispatch-due sweep) were switched from `MongoMemoryReplSet` to a bare **standalone** `mongod` and all
pass. A plain standalone `mongod` (or Atlas) is therefore sufficient in every environment — no
`--replSet`, no `replicaSet=` in the connection string.

## Consequences

- **Simpler build and deploy.** No `prisma generate` in CI or the Dockerfile, no generated client to
  copy between stages, no engine binary or `binaryTargets` to pin — a smaller image and a lighter
  serverless action.
- **Simpler topology.** Local dev, CI, and production all run a standalone `mongod`; no replica set to
  provision or document.
- **We now hand-write mapping and index creation** that Prisma's schema previously generated — more
  explicit code in `infrastructure/` and `shared/persistence`, but it is small, colocated with the
  repository it serves, and no longer a lowest-common-denominator schema DSL.
- **We forgo Prisma's typed query surface** at the repository boundary. Accepted: the repositories are
  a known, finite set already covered by contract tests, and staying on the portable subset keeps the
  queries trivial.
- If a future use case genuinely needs a multi-document transaction, a replica set (and the driver's
  session API) becomes necessary again — that is the point at which to revisit the "no transactions"
  stance, not before.

## Related

- Supersedes [ADR-007](ADR-007-persistence-prisma-mongodb.md) — Prisma + MongoDB, DB-portable.
- ADR-001 — Clean Architecture (repository interfaces in `application/`, the swap seam).
- ADR-003 — Dependency Injection (binding/rebinding repository implementations, the pooled client).
- ADR-009 — Deployment (connect once at module scope; serverless action size).
- ADR-011 — Bounded contexts (which components own which repositories).
