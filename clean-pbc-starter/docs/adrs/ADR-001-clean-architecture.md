# ADR-001: Clean Architecture

## Status

Proposed — baseline default. Ratify or amend for your project before treating as Accepted.

## Context

We need a consistent way to structure application code that keeps business logic testable and
independent of frameworks, databases, and delivery mechanisms.

Two related patterns are often conflated: **Clean Architecture** (Robert C. Martin) and **Hexagonal /
Ports & Adapters** (Alistair Cockburn). They share a dependency rule but differ in vocabulary. This
baseline commits to **Clean Architecture** and does not use "ports"/"adapters" as architectural
terms — we use **"gateway"** for an interface to an external system.

A sharper distinction is **where interfaces live**. In pure Clean Architecture the interface a use
case needs (a data gateway / "repository") is owned by the **use-case (application) layer** — this is
Martin's own model ("repositories … implement an interface determined at the use case level"). The
common .NET/DDD "Clean Architecture" hybrid instead puts repository and domain-service interfaces in
the **domain** layer. This baseline chooses **pure Clean**: the domain layer holds only business
objects, not outward-facing interfaces.

Clean Architecture (dependency topology) and DDD (domain modeling) are **compatible and
complementary** — Clean says which way dependencies point; DDD says how to model the domain (bounded
contexts, entities, value objects). This baseline keeps DDD's *modeling* while declining DDD's
*placement* of interfaces in the domain.

## Decision

Adopt Clean Architecture with one hard rule and four layers.

### The Dependency Rule

Source-code dependencies point **inward only**. Inner layers know nothing of outer layers. To cross
a boundary outward at runtime, use **Dependency Inversion**: the inner layer defines an interface;
the outer layer implements it.

### Layers

- **`domain/`** — entities, value objects, domain errors. Pure; no framework, no IO, and **no
  interfaces to the outside world**.
- **`application/`** — use cases (interactors) **and the interfaces they depend on** (data
  gateways / "repositories", service abstractions) + DTOs.
- **`infrastructure/`** — implementations of the application's interfaces: databases, external
  clients, filesystem, DI wiring.
- **`presentation/`** — delivery: controllers/handlers/routes (HTTP, WS, CLI, …). Thin; translates
  requests into use-case calls.

`presentation` and `infrastructure` are the two halves of Clean's "Interface Adapters" ring, split
for cohesion; the dependency rule is unchanged.

### Rules

- Interfaces live with their **consumer**. Use cases own the interfaces they call → `application/`.
  The implementation lives outermost (`infrastructure/`) and reaches inward.
- `domain/` never imports anything outward. **No `domain/repositories/`, no `domain/services/`**
  (those are DDD conventions, not Clean).
- "Gateway" is the general term for an interface to any external system; a repository is the
  persistence-flavored gateway, an API client the remote-service-flavored one.
- Controllers/handlers are thin — no business logic; use cases never depend on delivery types (an
  HTTP request object, a socket, etc.).

## Consequences

- Business logic is testable without a database, framework, or network.
- Implementations are swappable (in-memory for tests, real for production) behind their interfaces.
- More indirection than a plain layered app — justified by testability and boundary clarity; can
  feel heavy for trivial CRUD.
- The rings are **conceptual**, not a mandated folder tree — ADR-002 defines how they map onto
  directories.

## Related

- ADR-002 — Package-by-component (how the layers map onto directories)
- ADR-003 — Dependency Injection (how implementations bind to interfaces)
- Robert C. Martin, "The Clean Architecture" (2012) and "Screaming Architecture" (2011)
