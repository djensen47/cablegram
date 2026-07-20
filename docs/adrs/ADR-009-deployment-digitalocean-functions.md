# ADR-009: Deployment — DigitalOcean Functions → Docker

## Status

Accepted — 2026-07-19. The Docker target is a stated future goal; the scheduling mechanism is `Open`
(see Consequences).

## Context

cablegram deploys initially on **DigitalOcean Functions** (via App Platform, or plain Functions),
with an **eventual Docker image** as a goal. These runtimes have different properties, and the code
must run on both without a rewrite:

- **DO Functions** are **stateless and ephemeral** — short-lived invocations, no guaranteed local
  disk, no in-process state between requests, and a **wall-clock time limit** per invocation.
- A **Docker image** is a long-lived process (a Node server) — it *could* hold state and run
  background work, but we choose not to rely on that so the two targets stay behaviorally identical.

This constraint is the reason for several earlier decisions: Postmark owns send fan-out (ADR-008),
Hono runs on both runtimes via adapters (ADR-006), and the DI container is built once at module
scope (ADR-003).

## Decision

### Design to the stricter runtime (functions)

- Treat the app as **stateless and ephemeral everywhere**: no in-process background workers, no
  long-running loops, no reliance on local disk or in-memory state surviving between requests. Code
  that holds for DO Functions also holds in Docker.
- **No long jobs in a request.** Anything unbounded (sending to a large audience) is delegated to an
  external system built for it — Postmark's Bulk API (ADR-008) — not run inside an invocation.

### One app, two entrypoints

- The Hono app (ADR-006) is assembled once. Two thin entrypoints wrap it:
  - **DO Functions**: a function handler adapter over the Hono app.
  - **Docker**: `@hono/node-server` hosting the same app as a long-lived process.
- Business/handler code is identical across both; only the entrypoint differs.

### Statelessness helpers

- Build the Inversify container at **module scope** so warm function instances reuse it (ADR-003).
- Configuration comes from **environment variables** (Postmark token, Mongo connection string), not
  files on disk. Secrets are injected by the platform.
- The database (MongoDB, ADR-007) is the only durable state; connections are pooled at module scope
  and must tolerate cold starts.

## Consequences

- The same codebase ships to DO Functions now and Docker later with only an entrypoint swap — the
  Docker goal costs a small adapter, not a re-architecture.
- Designing to the ephemeral runtime forbids conveniences (in-process cron, background queues,
  local caches). This is what pushes sending to Postmark (ADR-008) and keeps the app simple.
- Cold-start cost is real; the small Hono footprint (ADR-006) and module-scope container mitigate it.
- **Open — scheduling.** Scheduled campaigns need a time trigger, which an ephemeral function can't
  provide itself. Candidate mechanisms: DO Functions **scheduled triggers**, an external cron hitting
  a protected endpoint, or App Platform jobs. Deferred to its own decision when scheduling is built;
  none of the above changes the send architecture in ADR-008.

## Related

- ADR-003 — Dependency Injection (module-scope container)
- ADR-006 — HTTP delivery (the shared Hono app + per-target adapters)
- ADR-008 — Email delivery (why fan-out is delegated, not run in-process)
- ADR-007 — Persistence (Mongo as the only durable state)
