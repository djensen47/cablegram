# ADR-001: Clean Architecture

## Status

Accepted — 2026-07-19.

## Context

cablegram needs a consistent way to structure code that keeps business logic — subscriptions,
campaigns, sending — testable and independent of Hono, Prisma/MongoDB, and Postmark.

Two related patterns are often conflated: **Clean Architecture** (Robert C. Martin) and **Hexagonal /
Ports & Adapters** (Alistair Cockburn). They share a dependency rule but differ in vocabulary. We
commit to **Clean Architecture** and do not use "ports"/"adapters" as architectural terms — we use
**"gateway"** for an interface to an external system (`DeliveryGateway`, `SubscriptionRepository`).

A sharper distinction is **where interfaces live**. In pure Clean Architecture the interface a use
case needs (a data gateway / "repository") is owned by the **use-case (application) layer**. The
common .NET/DDD hybrid instead puts those interfaces in the **domain** layer. cablegram chooses
**pure Clean**: the domain layer holds only business objects, not outward-facing interfaces.

Clean Architecture (dependency topology) and DDD (domain modeling) are compatible: Clean says which
way dependencies point; DDD says how to model the domain. We keep DDD's *modeling* and decline its
*placement* of interfaces in the domain.

## Decision

Adopt Clean Architecture with one hard rule and four layers.

### The Dependency Rule

Source-code dependencies point **inward only**. Inner layers know nothing of outer layers. To cross
a boundary outward at runtime, use **Dependency Inversion**: the inner layer defines an interface;
the outer layer implements it.

### Layers

- **`domain/`** — entities, value objects, domain errors (`Subscription`, `Campaign`, `EmailAddress`,
  `SubscriptionStatus`). Pure; no framework, no IO, and **no interfaces to the outside world**.
- **`application/`** — use cases (interactors) **and the interfaces they depend on**
  (`SubscriptionRepository`, `DeliveryGateway`, `TemplateRenderer`, `Clock`) + DTOs.
- **`infrastructure/`** — implementations of those interfaces: Prisma repositories, the Postmark
  client, DI wiring.
- **`presentation/`** — delivery: Hono route handlers. Thin; translates HTTP requests into use-case
  calls (ADR-006). There is **no UI presentation** — cablegram is headless (ADR-004).

`presentation` and `infrastructure` are the two halves of Clean's "Interface Adapters" ring, split
for cohesion; the dependency rule is unchanged.

### Rules

- Interfaces live with their **consumer**. Use cases own the interfaces they call → `application/`.
  The implementation lives outermost (`infrastructure/`) and reaches inward.
- `domain/` never imports anything outward. **No `domain/repositories/`, no `domain/services/`.**
- "Gateway" is the general term for an interface to any external system; a repository is the
  persistence-flavored gateway (`SubscriptionRepository`), the Postmark client the remote-service one
  (`DeliveryGateway`).
- Handlers are thin — no business logic; use cases never depend on delivery types (a Hono `Context`,
  a raw webhook body).

## Consequences

- Business logic (recipient resolution, send orchestration) is testable without MongoDB, Hono, or a
  live Postmark account.
- Implementations are swappable behind interfaces: in-memory repos for tests, Prisma for prod;
  Postmark today, SMTP/SES later (ADR-008).
- More indirection than a plain layered app — justified by testability and the DB-portability goal
  (ADR-007); can feel heavy for trivial CRUD.
- The rings are **conceptual**, not a mandated folder tree — ADR-002 maps them onto directories.

## Related

- ADR-002 — Package-by-component (how layers map onto directories)
- ADR-003 — Dependency Injection (how implementations bind to interfaces)
- ADR-006 — HTTP delivery (the `presentation/` framework)
- ADR-007 — Persistence (the `infrastructure/` repositories)
- Robert C. Martin, "The Clean Architecture" (2012), "Screaming Architecture" (2011)
