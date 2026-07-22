# ADR-009: Deployment — DigitalOcean Functions → Docker

## Status

Accepted — 2026-07-19. The Docker target is a stated future goal. Scheduling (see Consequences) is
**deferred to Phase 2**: the v1 build ships send-on-demand only; an earlier external-trigger endpoint
was removed, and the design sketch below is retained for when scheduling is built properly.

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
- The database (MongoDB, ADR-012) is the only durable state; connections are pooled at module scope
  and must tolerate cold starts.

## Consequences

- The same codebase ships to DO Functions now and Docker later with only an entrypoint swap — the
  Docker goal costs a small adapter, not a re-architecture.
- Designing to the ephemeral runtime forbids conveniences (in-process cron, background queues,
  local caches). This is what pushes sending to Postmark (ADR-008) and keeps the app simple.
- Cold-start cost is real; the small Hono footprint (ADR-006) and module-scope container mitigate it.
- **Deferred to Phase 2 — scheduling.** Scheduled campaigns need a time trigger, which an ephemeral
  function can't provide itself. **v1 ships send-on-demand only** (`POST /v1/campaigns/{id}/send`). An
  earlier v1 build carried an external-trigger endpoint (`POST /v1/campaigns/dispatch-due` + a
  `scheduled` status + `scheduledAt`); it was **removed** so the API surface doesn't advertise a
  half-owned feature (a "cron" mechanism was baked in without review — see the removal branch). The
  prior code is recoverable from git history (the removal is one revertable commit); this note
  preserves the *design* so Phase 2 doesn't re-derive it:

  - **Trigger:** a time-based caller pings a protected endpoint — there is still no in-process timer,
    so an ephemeral runtime cannot self-wake. Phase 2 should prefer a **DigitalOcean-native**
    scheduler — App Platform **Jobs** (cron-like; ~15-minute granularity today) or Functions
    **scheduled triggers** (beta; confirm App-Platform availability at build) — while keeping the
    endpoint generic enough that *any* timed HTTP caller works, not just one provider's scheduler.
    Under JWT-only auth (ADR-013) the trigger's credential is an open Phase-2 decision: an
    authenticated service account, or an internal entrypoint outside the `/v1` JWT surface.
  - **Sweep semantics (keep):** setting `Campaign.scheduledAt` moves a campaign to `scheduled`; the
    endpoint runs a use case that fetches a **bounded batch** of due campaigns (`status = scheduled`
    and `scheduledAt <= now`, oldest-due first) via a `listDue(now, limit)` repository method (backed
    by a `(status, scheduledAt)` index) and runs the ordinary `SendCampaign` pipeline on each **one at
    a time**, so a single call can't exceed a function's time budget; call again for the rest.
  - **Force-fail rule (keep — easy to lose):** a due campaign that fails **before** `SendCampaign`
    marks it `sending` (e.g. its newsletter/template reference vanished after it was scheduled) must
    be force-`failed` by the sweep itself — otherwise it stays `scheduled` and fails on every tick
    forever.
  - Nothing about ADR-008's send architecture changes, and Phase 2 is **additive** on the unchanged
    send pipeline (`SendCampaign`/`SendRecord`/webhooks), which is why removing scheduling now is
    cheap to reverse later.

## Related

- ADR-003 — Dependency Injection (module-scope container)
- ADR-006 — HTTP delivery (the shared Hono app + per-target adapters)
- ADR-008 — Email delivery (why fan-out is delegated, not run in-process)
- ADR-012 — Persistence (Mongo as the only durable state)
