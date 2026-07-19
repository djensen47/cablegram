# ADR-003: Dependency Injection

## Status

Proposed — baseline default. Ratify or amend for your project before treating as Accepted.

## Context

Clean Architecture (ADR-001) has inner layers depend on interfaces that outer layers implement;
something must bind adapters to those interfaces at a composition root. Options are manual wiring or
a container. For TypeScript, **Inversify** is the mature IoC container and handles the common
"one interface, multiple implementations, rebind in tests" case cleanly.

## Decision

### Container

- **Inversify** across all TypeScript packages. **One composition root per app**; library packages
  export `ContainerModule`s the app's root loads. The composition root is the only place that names
  concrete implementations.

### Injection discipline

- **Inject only interfaces** — every injected dependency is typed as an interface, never a concrete
  class. (Practical exception: config/value objects injected by token.)

### Naming

- **Interface** = the bare Thing, no `I`-prefix — `UserRepository`, not `IUserRepository`.
- **Implementation** = `<Qualifier>Thing` — `PostgresUserRepository`, `InMemoryUserRepository`.
- Use **`Default`** as the qualifier for the single canonical implementation (`DefaultClock`); an
  edge-case sibling (`SystemClock`) does not force the original to be renamed.

### Tokens

- DI tokens live in a **`types.ts`** exporting `TYPES = { X: Symbol.for("X") }` (Inversify's
  convention). Tests **rebind** a token to a mock — the standard test seam.

### Frontend boundary (important)

- The container wires **framework-agnostic logic** (use cases, gateways, services). **React-native
  tools stay idiomatic** — the query client via its own provider, stores as hooks — and are **not**
  registered in the container. React reaches the container via context + a `useInjection`-style
  hook. Never use the container as a service locator sprinkled inside components.

### Non-TypeScript layers

- A non-TS layer (e.g. a Rust/Tauri shell) uses idiomatic **constructor injection / trait objects**,
  not Inversify.

## Consequences

- Decorators require `reflect-metadata` and tsconfig `experimentalDecorators` /
  `emitDecoratorMetadata` (set once in a shared base config).
- Rebind-to-mock is a uniform, clean test seam across packages.
- Some bundle-size cost on the frontend; acceptable for app surfaces.
- The "magic" of a container is centralized in one composition root, not scattered.

## Related

- ADR-001 — Clean Architecture (the interfaces being bound)
- ADR-002 — Package-by-component (per-component modules the root loads)
- ADR-004 — Frontend state (why the query client / stores stay outside the container)
