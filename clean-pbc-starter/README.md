# Clean + Package-by-Component Architecture Starter

A reusable set of **baseline ADRs** and templates encoding a TypeScript **Clean Architecture /
package-by-component** stance. Drop it into a new project as a starting point — and change what
doesn't fit.

## The stance in a paragraph

Pure Clean Architecture — the dependency rule, interfaces live with the use cases in `application/`,
`domain/` is entities + value objects only. Code is organized **package-by-component** (capabilities
as folders behind `index.ts` facades). **Inversify** for dependency injection, with interface-only
injection and consistent naming. A three-tier **frontend state** model (server / shared-client /
local). Boundaries are **enforced** by `index.ts` facades + a boundary linter, since TypeScript has
no `package-private`.

## How to use

1. Copy `docs/adrs/` into your project.
2. Treat each ADR as a **baseline default — ratify or amend** for your context. The reasoning lives
   in each ADR's Context, so you can re-decide rather than cargo-cult. Flip `Status` to `Accepted`
   once you've ratified it.
3. Use `docs/adrs/_TEMPLATE.md` for new ADRs.
4. Drop a scoped `CLAUDE.md` (from `CLAUDE.md.skeleton`) into each app/package — pointing at the
   relevant ADRs plus that surface's specifics.

## The three-doc workflow

- **decision-log** — an in-flight scratchpad while decisions are still moving (a single markdown
  file with Locked / Open / Parking-lot sections). Detail lives here; you resolve one decision at a
  time.
- **ADR** — a settled decision *and its why*. Durable.
- **CLAUDE.md** (scoped) — the operative rules distilled from the ADRs; terse, always in context,
  **links** the ADR and never re-explains the why.

Flow: **discuss → decision-log → ADR → scoped CLAUDE.md → code.**

## Contents

- `docs/adrs/_TEMPLATE.md` — the thin ADR template
- `docs/adrs/ADR-001-clean-architecture.md`
- `docs/adrs/ADR-002-package-by-component.md`
- `docs/adrs/ADR-003-dependency-injection.md`
- `docs/adrs/ADR-004-frontend-state.md`
- `docs/adrs/ADR-005-boundary-enforcement.md`
- `CLAUDE.md.skeleton` — a scoped-CLAUDE.md starting point

## What this starter does NOT decide for you

Per-project calls the template can't make: your **bounded contexts**, your **app topology** (how many
apps), and **package-by-component vs ports-and-adapters** per surface (ADR-002 explains when to
prefer p&a). The starter ships the *method and defaults*; you fill in the domain.
