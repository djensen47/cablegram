# ADR-004: Frontend State Management

## Status

Proposed — baseline default. Ratify or amend for your project before treating as Accepted.

## Context

A frontend juggles three genuinely different kinds of state. Conflating them — e.g. one global store
holding server responses, derived UI flags, and form text — forces you to hand-roll cache
invalidation for server data and needlessly globalizes ephemeral state.

## Decision

Three categories, one tool each:

| State kind | Tool | Examples |
|---|---|---|
| Server state | **TanStack Query** | anything owned by an API / backend |
| Shared client state | **Zustand** | selection, layout, theme — client-owned, cross-component |
| Local UI state | **React `useState` / `useReducer`** | form fields, toggles, hover |

### Decision rule

Ask in order: server-owned? → TanStack Query. Shared client state? → Zustand. Component-local? →
React.

### Rules

- **Do not mirror server state into Zustand** (banned). Zustand may hold a *key/reference* (e.g. a
  selected id) that Query then resolves; the server data itself stays in Query.
- Real-time transports (WebSocket, SSE) **patch or invalidate the Query cache** rather than living in
  a parallel store.
- Per ADR-003, the query client and the stores are frontend adapter-ring pieces and stay
  framework-idiomatic (not in the DI container).

## Consequences

- Server-state concerns (caching, refetch, retry, loading/error) are the library's, not bespoke
  code.
- Three tools to learn, but each does one job; the decision rule removes "where does this go?".
- The no-mirroring rule is load-bearing and enforced in review.
- **Redux is deliberately not chosen** — heavier than this split needs, and it still requires a
  query layer for server state.

## Related

- ADR-001 — Clean Architecture (the frontend's inner rings)
- ADR-003 — Dependency Injection (the frontend DI boundary)
