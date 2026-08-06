# ADR-028: Containers Only — retiring the DigitalOcean Functions target

## Status

Accepted — 2026-08-05. Supersedes [ADR-009](ADR-009-deployment-digitalocean-functions.md)'s choice of
*target*. **ADR-009's runtime constraints are not superseded** — see §3.

## Context

[ADR-009](ADR-009-deployment-digitalocean-functions.md) picked DigitalOcean Functions as the initial
deployment target with Docker as "an eventual goal", and told the code to *design to the stricter
runtime*: stateless, ephemeral, no background workers, no long in-request loops, no local disk,
pool at module scope. Everything downstream took that seriously — Postmark owns send fan-out with no
queue and no worker (ADR-008), the container is built once at module scope (ADR-003), scheduled sends
were deferred rather than implemented with an in-process timer.

The target itself never worked out, and three separate things have now said so:

1. **It was never verified.** `project.yml` shipped self-documented as a "best-effort second target",
   "NOT been deployed/verified with `doctl serverless deploy`", carrying two unresolved risks (the
   48 MB deployed-action limit against this dependency graph, and DO's per-action `npm install` not
   mapping onto a package-by-component layout with one shared `dist/`). It sat in the repo for two
   weeks in that state.
2. **The in-repo build was already abandoned.** ADR-026 records it: a DO function's `build.sh` may
   only reference its own directory or `lib/`, which App Platform enforces on a remote build. That is
   what made **npm the distribution seam** and established that *this repo is not a deployment*.
3. **Functions cannot reach the database.** DO Functions components cannot join a VPC, so they cannot
   reach a privately-addressed MongoDB (issue #44). This is not a packaging problem with a workaround
   — it is the runtime being unable to talk to the only durable state the app has.

(3) is decisive on its own. What remained was an unverified config file and a 90-line OpenWhisk
adapter published as `cablegram/function`, maintained for a target nothing can deploy to.

### What "keeping it just in case" actually costs

The tempting move is to leave it — dead code is cheap. It is not cheap here, because it is *load-bearing
in the documentation*: ADR-009's constraints are cited across the codebase as "because DO Functions",
and a reader who checks discovers the justification names a runtime that cannot be used. That
teaches the constraints are obsolete, which is the opposite of true. A published `./function` export
is worse than dead code — it is a **promise**, and promises are versioned (ADR-026).

## Decision

**cablegram deploys as a long-running container. The DigitalOcean Functions target is retired.**

### 1. Deleted

- `src/function.ts` — the OpenWhisk raw-web-action adapter (`__ow_method`/`__ow_headers`/`__ow_path`/
  `__ow_query`/`__ow_body` → `Request`, and back to `{statusCode, headers, body}`).
- `project.yml` — the DO Functions project config, never deployed.
- The `./function` entry in the package's `exports` map. **This is a breaking change** and the reason
  the release carrying it is a major version (ADR-026 derives that from the commit).

### 2. The two shapes that remain

Both are the same Hono app; neither is provider-specific:

- **Standalone** — `dist/server.js` on `@hono/node-server`, the `Dockerfile`'s `CMD`. Its own
  container, its own port.
- **Embedded** — the `"."` library entrypoint ([ADR-027](ADR-027-library-entrypoint.md)), mounted
  under a path prefix inside a host service. This is the shape the private-VPC database needs, and
  what issue #44 asked for.

`src/index.test.ts` asserts the `exports` map contains exactly `"."` and `"./package.json"` — a new
`./<provider>` entry is the retired shape growing back.

### 3. ADR-009's constraints survive, and are now justified on their own terms

Stateless and ephemeral, no background workers, no long in-request loops, no local disk or in-memory
state between requests, config from env, one pooled client at module scope — **all still binding.**
They are re-derived without Functions in three lines:

- A container is **replicated and restarted**. Anything held in one process's memory is lost on a
  deploy and invisible to the other replica, so in-memory state can never be a correctness
  requirement (this is exactly what `InMemoryIdempotencyStore` already documents about itself).
- A request is **bounded by the load balancer**, not by a function timeout. Sending to 18k
  recipients inside one HTTP request is a bad idea in a container for the same reason it was
  impossible in a function — which is why Postmark still owns fan-out (ADR-008), and why no queue,
  worker or cursor comes back.
- **Config from env, never files** — unchanged, and the property that lets the same image run
  standalone or be mounted by a host that supplies its own env object.

So this ADR retires a *target*, not a *discipline*. Do not read it as permission to add a worker.

### 4. Earlier ADRs keep their text; their DO-specific reasoning is historical

ADR-003, 006, 008, 012, 019, 021, 023 and 026 all cite DO Functions somewhere in their reasoning. They
are **not** being rewritten — an ADR is a record of a decision and the forces at the time, and editing
old ones to match today is how a decision log becomes fiction. Two of those references are worth
naming explicitly, because they are technical claims a reader could act on:

- **ADR-021** argued for recording unhandled webhook events partly because *DO activation logs cannot
  be searched or alerted on*. Container logs can be. The decision stands on its remaining reasons —
  a log answers "what happened in this request", not "is Postmark sending us anything we're
  dropping?", and the record is what `GET /v1/webhooks/unhandled` reads back — but the sharpest
  argument for it is now historical, and the in-code comments say so.
- **ADR-023** noted there is *no socket to read* because the Functions entrypoint rebuilds a `Request`
  from `__ow_headers`. A container has a socket. The decision is unchanged, on a better reason: a
  deployed container sits behind a load balancer and an embedded one behind its host, so the peer
  address is a proxy, not the subscriber. `X-Forwarded-For` remains the only thing that can carry a
  client address, and remains corroboration rather than proof.

## Consequences

- **One deployment story, verified**, instead of a shipped one and an aspirational one. `docs/deployment.md`
  no longer documents caveats for a path nobody can take.
- **A major version.** Anyone importing `cablegram/function` breaks — which is, as far as we know,
  nobody, since the target it served cannot reach a database.
- **Scheduled sends get easier, and that is a trap.** A long-lived process *can* run a timer, and
  Phase 2 scheduling will be tempted by it. §3 is the standing answer: replicas mean two timers, a
  deploy means a missed tick. The DO-native trigger plan in ADR-009 was never the only option, but
  "just use `setInterval`" was never one of them.
- **Re-adding a serverless target later is real work**, not a revert: a new adapter, a new export
  (a `feat:`), and a fresh answer to how it reaches the database. That cost is the point — the
  previous arrangement let an unverified target look supported for two weeks.
- ADR-009 stays in the index as the record of why the constraints exist. A reader now needs two ADRs
  to understand deployment, which is the normal cost of superseding one.

## Related

- [ADR-009](ADR-009-deployment-digitalocean-functions.md) — superseded *as a target choice*; its
  runtime constraints stand (§3).
- [ADR-027](ADR-027-library-entrypoint.md) — the embedded shape, and what the package exports now.
- [ADR-026](ADR-026-release-and-distribution.md) — why removing an export is a major version, and the
  earlier finding (the abandoned in-repo `build.sh`) that started this.
- [ADR-008](ADR-008-email-delivery-postmark.md) — Postmark owns fan-out; unchanged, and the reason no
  worker returns.
- [`../deployment.md`](../deployment.md) · [`../embedding.md`](../embedding.md) — the two shapes.
- Issue [#44](https://github.com/djensen47/cablegram/issues/44).
