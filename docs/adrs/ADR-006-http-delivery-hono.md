# ADR-006: HTTP Delivery with Hono

## Status

Accepted — 2026-07-19.

## Context

cablegram's only delivery mechanism is an HTTP JSON API (ADR-004). We need a web framework for the
`presentation/` layer (ADR-001). Constraints that shape the choice:

- It must run on **DigitalOcean Functions / App Platform** today and inside a **Docker image / Node
  server** later (ADR-009) — i.e. the same handler code should run in both a function runtime and a
  long-lived server without rewrites.
- It should stay **thin** — handlers translate HTTP into use-case calls and nothing more (ADR-001).

**Hono** is a small, Web-standard (`Request`/`Response`) router that runs on Node, Bun, Deno, edge
runtimes, and serverless functions via adapters. That runtime-portability is the deciding factor
given the DO-Functions-now / Docker-later path.

## Decision

- **Hono** is the HTTP framework, living in each component's `presentation/` layer. Routes are
  mounted onto one app the composition root assembles.
- **Handlers are thin.** A handler: parses/validates input → calls a use case (resolved from the
  Inversify container, ADR-003) → maps the result to a response DTO. **No business logic in
  handlers**; use cases never see the Hono `Context`.
- **Validate at the edge.** Parse and validate request bodies/params with a schema validator (e.g.
  `zod` via Hono's validator middleware) before constructing use-case DTOs. Domain entities and
  Prisma types are **never** serialized directly (ADR-004).
- **One app, many runtimes.** The assembled Hono app is exported once and wrapped by the appropriate
  adapter per target — a function handler on DO Functions, `@hono/node-server` in Docker (ADR-009).
  Handler code does not change between targets.
- Cross-cutting HTTP concerns (auth, request-id, error-to-response mapping) are Hono middleware kept
  in `src/shared/http`.

## Consequences

- The same presentation code runs serverless and containerized — no framework migration when the
  Docker goal lands (ADR-009).
- Small dependency footprint and fast cold starts, which matter on ephemeral functions.
- Hono is less batteries-included than Express/Nest — we add validation, auth, and error mapping as
  explicit middleware rather than getting them by convention. Acceptable, and keeps handlers thin.
- Web-standard `Request`/`Response` keep us portable if a runtime changes again.

## Related

- ADR-001 — Clean Architecture (thin controllers; `presentation/` layer)
- ADR-003 — Dependency Injection (handlers resolve use cases from the container)
- ADR-004 — Headless / API-only (HTTP is the whole product surface)
- ADR-009 — Deployment (the function and Docker adapters)
