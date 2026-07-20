# ADR-002: Package-by-Component

## Status

Accepted — 2026-07-19.

## Context

Clean Architecture's rings (ADR-001) are conceptual, not a directory layout — so we still choose how
code is organized at the top level.

Simon Brown's "The Missing Chapter" evaluates four schemes: **package by layer**, **package by
feature**, **ports and adapters**, and **package by component**. Package-by-layer and -by-feature are
the weaker two (they don't enforce boundaries). The two sound ones are **ports-and-adapters** and
**package-by-component**. *Screaming Architecture* adds the principle: the top level should reflect
the **domain**, not the framework.

cablegram's capability boundaries are reasonably knowable — a newsletter system decomposes into
newsletters, subscriptions, deliverability, templates, and campaigns (sending and event-handling are
shared infrastructure, not capabilities — ADR-011) — so we choose **package-by-component**.
Ports-and-adapters would be the call only if the domain were one cohesive blob with unknown seams;
it isn't.

## Decision

### Organize by component (capability), not by layer

- **Top-level = capabilities** (components), each a folder bundling its own Clean layers
  (`domain/` `application/` `infrastructure/` `presentation/`) *inside* it.
- Each component exposes **one public API via `index.ts`** (a facade); everything else is internal.
- Cross-cutting technical capabilities live in a **library of small, focused shared modules** under
  `src/shared/` (config, ids, clock, http, di), each with its own facade — not dumped into one god
  "kernel."
- The top level *screams* the domain (`newsletters/`, `subscriptions/`, `campaigns/`), not the framework.

The concrete component list is ADR-011 (`Proposed`). This ADR fixes the *scheme*; ADR-011 fixes the
*slices*.

### One app

cablegram is a single deployable app (ADR-009), not a monorepo of many apps. Components are folders
within it; **packages** are reserved for genuinely shared/cross-app code, of which there is little.

## Consequences

- The structure screams the newsletter domain, and component boundaries double as future
  extraction (microservice) seams — e.g. `delivery/` could split out if send volume demands it.
- It asks us to commit to capability boundaries — **start coarse and split** as the domain clarifies
  (ADR-011 starts deliberately coarse); re-slicing an existing boundary is the expensive case.
- Cross-component workflows (a campaign send touches newsletters + subscriptions + deliverability +
  templates + the `email` module) go through facades / app-layer coordination rather than reaching
  across internals.
- **Enforcement is mandatory** (ADR-005): without it, package-by-component silently degrades into
  package-by-feature with everything public.

## Related

- ADR-001 — Clean Architecture (the layers that nest inside each component)
- ADR-005 — Boundary enforcement (what makes the facades real)
- ADR-011 — Bounded contexts & component topology (the actual component list)
- Simon Brown, "The Missing Chapter"; R. C. Martin, "Screaming Architecture"
