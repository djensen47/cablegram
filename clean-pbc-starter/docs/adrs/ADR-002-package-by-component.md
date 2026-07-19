# ADR-002: Package-by-Component

## Status

Proposed — baseline default. Ratify or amend for your project before treating as Accepted.

## Context

Clean Architecture's rings (ADR-001) are conceptual, not a directory layout — so we still need to
choose how code is organized at the top level.

Simon Brown's "The Missing Chapter" (in *Clean Architecture*) evaluates four schemes: **package by
layer**, **package by feature**, **ports and adapters**, and **package by component**. Package-by-
layer and package-by-feature are the weaker two (they don't enforce boundaries — code can bypass a
layer or reach into a feature's internals). The two sound ones are **ports-and-adapters** and
**package-by-component**. Uncle Bob's *Screaming Architecture* adds the guiding principle: the top
level should reflect the **domain**, not the framework or the layers.

This baseline chooses **package-by-component**, and names when **ports-and-adapters** is the better
fit instead.

## Decision

### Organize by component (capability), not by layer

- **Top-level = capabilities** (components), each a folder that bundles its own Clean layers
  (`domain/` `application/` `infrastructure/` `presentation/`) *inside* it.
- Each component exposes **one public API via `index.ts`** (a facade); everything else is internal.
- Cross-cutting technical capabilities live in a **library of small, focused shared modules** (each
  with its own facade) — not duplicated per component, and **not** dumped into one god "kernel."
- The top level *screams* the domain (`orders/`, `billing/`, …), not the framework.

### Per surface

- Applies to backend and frontend alike. On a **frontend**, a "component" is a **feature module** —
  not a UI/React component (name collision). The shared UI / design system is its own package.
- On a frontend, the Clean inner rings still hold (framework-agnostic domain + use cases); the UI
  framework and gateways are the outer edge (see ADR-004).

### When to prefer ports-and-adapters instead

Choose **ports-and-adapters** (organize inside = framework-free core vs outside = adapters) when:
- your capability boundaries are genuinely unknown and you want zero commitment yet,
- the domain is one cohesive thing rather than several separable capabilities, or
- there is no service-extraction goal.

Package-by-component's advantage — a component boundary that doubles as a future-service seam — only
pays off once boundaries are known.

## Consequences

- The structure screams the domain, and component boundaries double as extraction (microservice)
  seams.
- It asks you to commit to capability boundaries — **start coarse and split** as the domain
  clarifies; re-slicing an existing boundary is the expensive case.
- Cross-component workflows go through facades / app-layer coordination rather than reaching across.
- **Enforcement is mandatory** (ADR-005): without it, package-by-component silently degrades into
  package-by-feature with everything public.

## Related

- ADR-001 — Clean Architecture (the layers that nest inside each component)
- ADR-005 — Boundary enforcement (what makes the facades real)
- Simon Brown, "The Missing Chapter"; R. C. Martin, "Screaming Architecture"
