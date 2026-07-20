# ADR-003: Dependency Injection

## Status

Accepted — 2026-07-19.

## Context

Clean Architecture (ADR-001) has inner layers depend on interfaces that outer layers implement;
something must bind implementations to those interfaces at a composition root. Options are manual
wiring or a container. **Inversify** is the mature TypeScript IoC container and handles the common
"one interface, multiple implementations, rebind in tests" case cleanly — exactly cablegram's shape
(`DeliveryGateway` → Postmark or SMTP; `SubscriptionRepository` → Prisma or in-memory).

DI here is a **backend-only** concern: cablegram is headless (ADR-004), so there is no React, no
query client, and no `useInjection` boundary to reason about — the container wires services, gateways,
and repositories, and nothing else.

## Decision

### Container

- **Inversify** across the app. **One composition root**; each component (ADR-011) exports an
  Inversify `ContainerModule` the root loads. The composition root is the only place that names
  concrete implementations (`PostmarkDeliveryGateway`, `PrismaSubscriptionRepository`).

### Injection discipline

- **Inject only interfaces** — every injected dependency is typed as an interface, never a concrete
  class. (Practical exception: config/value objects injected by token.)

### Naming

- **Interface** = the bare Thing, no `I`-prefix — `SubscriptionRepository`, not `ISubscriptionRepository`.
- **Implementation** = `<Qualifier>Thing` — `PostmarkDeliveryGateway`, `PrismaSubscriptionRepository`,
  `InMemorySubscriptionRepository`.
- Use **`Default`** as the qualifier for the single canonical implementation (`DefaultClock`); an
  edge-case sibling (`SystemClock`) does not force the original to be renamed.

### Tokens

- DI tokens live in a **`types.ts`** exporting `TYPES = { X: Symbol.for("X") }` (Inversify's
  convention). Tests **rebind** a token to a mock — the standard test seam.

### Composition root under serverless

- cablegram runs on ephemeral DigitalOcean Functions (ADR-009). Keep container construction **cheap**
  and build it at **module scope** so a warm invocation reuses it rather than rebuilding per request.
  No per-request container. Nothing in the container may hold long-lived local state.

## Consequences

- Decorators require `reflect-metadata` and tsconfig `experimentalDecorators` /
  `emitDecoratorMetadata` (set once in a shared base config).
- Rebind-to-mock is a uniform, clean test seam across components.
- The "magic" of a container is centralized in one composition root, not scattered — and it never
  becomes a service locator sprinkled through handlers.

## Related

- ADR-001 — Clean Architecture (the interfaces being bound)
- ADR-002 — Package-by-component (per-component `ContainerModule`s the root loads)
- ADR-009 — Deployment (why the container is built once at module scope)
