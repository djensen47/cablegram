# ADR-016: A First-Party CLI — an API *Client*, Not a Delivery Mechanism

## Status

Accepted — 2026-07-25.

## Context

cablegram is headless: [ADR-004](ADR-004-headless-api-only.md) says the product ships **no UI** and
that "the only delivery mechanism is an HTTP JSON API served by Hono." Operating it today therefore
means hand-rolling `curl` invocations — pasting a Bearer JWT into every call, remembering that the
list envelope is `{ data, meta: { nextCursor } }`, and re-authenticating by hand every fifteen
minutes when the access token expires. That is friction for the operator and it is the *only* way in,
because there is no other consumer of the API yet.

A CLI removes that friction. But "add a CLI" reads, on its face, like a direct contradiction of
ADR-004, so the decision has to name the distinction ADR-004 itself draws:

> "**headless / API-only** means *no UI in this repo* — not 'the API has no user-facing concerns.'
> The rendering client is out of scope; everything a client authenticates and talks to *is* the
> product."

ADR-004 scopes out **a UI as a delivery mechanism** — a second way into the domain, bypassing or
paralleling the HTTP API. It explicitly anticipates *clients*: "A UI (build-your-own or a later
first-party one) lives in its own repo and consumes this API." The question is therefore not "CLI:
yes or no," it is **which kind of CLI** — and the two candidates are genuinely different decisions:

1. **An in-process CLI** that builds the Inversify container and calls use cases directly against
   Mongo. This *is* a second delivery mechanism. It would add a non-HTTP `presentation/` kind to
   every component (contradicting ADR-001's "`presentation/` is exclusively HTTP handlers"), require
   `MONGODB_URI` and both Postmark tokens on an operator's laptop, and create a path into the domain
   that bypasses edge validation, idempotency, request logging, and the JWT/role gate
   ([ADR-013](ADR-013-authentication-user-accounts.md)). Every authorization rule would then need to
   hold in two places.
2. **An HTTP-client CLI** that speaks the same `/v1` API as any other consumer, authenticating with a
   normal user Bearer JWT. This adds **no** delivery mechanism. It is precisely the "build-your-own
   client" ADR-004 contemplates, only it happens to live in this repo and to render to a terminal
   instead of a browser.

Option 2 is the one that costs nothing architecturally, and it has a second benefit: the CLI becomes
the project's **first real consumer of its own contract**. ADR-004 puts the product weight on
contract stability; a first-party client that breaks when the contract breaks is the cheapest
possible pressure-test of that claim.

The remaining question is why the CLI lives *here* rather than in its own repo, as ADR-004 suggests
for a UI. A browser UI has its own build, its own state layer, and its own deployment; a CLI has
none of those, and it tracks the API contract version-for-version. Co-locating it means a contract
change and its client update land in one commit and one review, and the CLI's tests run on the same
`npm test` gate. A separate repo would buy isolation the CLI does not need and cost a publish step
on every contract change.

### Why a terminal client is not the "UI" ADR-004 excludes

The line worth holding: a **CLI is a client**; a **TUI dashboard is a product surface**. A
`commander` program that parses flags, calls `fetch`, and prints a table is a consumer of the
contract — swap it out and nothing about cablegram changes. A live full-screen dashboard (Ink,
blessed) starts making product decisions about *presentation* of the domain, carries client-side
state, and becomes something users evaluate cablegram by. That is the thing ADR-004 scoped out, and
it would need its own ADR (and probably its own repo). This ADR authorizes the former and
deliberately declines the latter.

## Decision

### 1. The CLI is an HTTP client, and only that

`src/cli/` talks to a cablegram deployment **exclusively over its public `/v1` HTTP API**, using a
user Bearer JWT obtained through the ordinary login flow (ADR-013). It:

- **never** imports a domain component (`newsletters`, `subscriptions`, `campaigns`, `templates`,
  `deliverability`, `accounts`) — not even through a facade;
- **never** constructs the Inversify container, opens a `MongoClient`, or reads `MONGODB_URI`,
  `POSTMARK_*`, or `JWT_SECRET`;
- has **no privileged path**: everything it can do, any API consumer with the same token can do.
  Role enforcement stays server-side (`requireRole`), and the CLI merely renders the 403.

This is enforceable and enforced: `src/cli/` imports nothing from `src/*/` at all, so the existing
`boundaries/element-types` rules (ADR-005) already reject the in-process variant — a `cli` layer
importing `newsletters` is not a named legal edge and is therefore denied by `default: 'disallow'`.
**No boundary-rule change was needed to add the CLI**, which is the check that it really is a leaf.

### 2. Structure: an ordinary component, with Clean layers, minus a domain

`src/cli/` is a component in the ADR-002 sense with the ADR-001 layers nested inside — but it has
**no `domain/`**, because it owns no business rules. Its "domain" is someone else's API.

```
src/cli/
  main.ts               — the bin shim: composes dependencies, runs the program
  index.ts              — the component facade (ADR-002)
  application/          — ApiClient + CredentialStore interfaces, ApiError, session types
  infrastructure/       — FetchApiClient (401 → refresh → retry), FileCredentialStore
  presentation/         — the commander program, command groups, output rendering, prompts
```

The layer rules fall out of the existing ESLint config unchanged: `presentation/` may import
`application/` but **not** `infrastructure/`, so composition happens in `main.ts` (the component
element, which may import both). That is the same inversion the server uses — the difference is that
the CLI wires it with **plain constructor injection rather than Inversify**. The container
(ADR-003) exists to manage the server's request-scoped, Mongo-backed graph; the CLI's graph is two
objects created once at process start. Adding a DI container there would be ceremony, not structure.

### 3. Interaction model: one-shot commands, with targeted interactivity

Every command is a **non-interactive, scriptable one-shot** — `cablegram campaigns send <id> --yes`
works in cron. Interactivity is confined to three places where a flag would be actively worse:

- **passwords** are prompted and masked, never accepted as a flag (a `--password` flag lands in shell
  history and in `ps`);
- **irreversible actions** (`campaigns send`, every `delete`) confirm before acting, suppressible
  with `--yes`;
- **omitted required arguments** are prompted for, so a bare `cablegram newsletters create` walks the
  operator through it.

When stdout is not a TTY, prompts are never attempted: a missing required input becomes an error
instead of a hang. `--json` is available on every command and switches output to the raw API body, so
the CLI composes with `jq` and stays parseable. This is the terminal-side equivalent of ADR-004's DTO
discipline: **a stable machine-readable shape is part of the contract**, and the human table is the
convenience layer on top.

A REPL (`cablegram shell`) and a TUI are **not** part of this decision. The command registry is
structured so a REPL could dispatch into it later; a TUI would need the reconsideration described
above.

### 4. Libraries: `commander` + `zod` + `@clack/prompts`

- **`commander`** (v15, zero runtime dependencies) for parsing, nested subcommands, and generated
  help. It is not the most modern design available — `@stricli/core` and `@drizzle-team/brocli` infer
  flag types into the handler where commander returns a loosely-typed bag — but see the next point.
- **`zod`** validates the parsed flags. This is what makes commander's weak typing a non-issue, and
  it is chosen deliberately over a type-inferring parser: the CLI edge then validates input **the
  same way the HTTP edge does** (ADR-006, `throwOnInvalid`), with the same library and the same error
  vocabulary, rather than introducing a second, parallel mechanism for the same job. One idiom, two
  edges.
- **`@clack/prompts`** (v1) for the masked password input and confirmations.
- **No HTTP client dependency.** Node 24's global `fetch` is the transport.

### 5. Credentials

Tokens live in `~/.config/cablegram/config.json` (honoring `XDG_CONFIG_HOME`), written `0600` in a
`0700` directory, and overridable per-invocation with `CABLEGRAM_URL` / `CABLEGRAM_TOKEN` for CI.
The file holds the base URL, the access token, its expiry, and the refresh token. **The refresh
token is a real credential at rest** — this is the same posture as `gh`/`aws` CLI config, and it is
why the mode bits are asserted rather than assumed. When the API returns 401, the client transparently
refreshes once, persists the rotated pair (refresh tokens rotate — ADR-013), and retries the request
exactly once before surfacing the failure.

## Consequences

- **ADR-004 is not amended, because it is not contradicted.** The HTTP API remains the only delivery
  mechanism; the CLI joins the set of clients ADR-004 explicitly anticipated. Had we chosen the
  in-process variant, ADR-004 *and* ADR-001 would both have needed amending — which is a large part
  of why we did not.
- **The contract gains a live consumer.** A breaking `/v1` change now breaks a test in this repo.
  That is the intended pressure, but it does mean contract changes carry a CLI update in the same PR.
- **The CLI cannot do anything the API cannot.** Operations with no endpoint (bulk export, arbitrary
  queries) are simply unavailable until the API offers them. This is a feature — it prevents the CLI
  from becoming a shadow API — but it will occasionally be felt as a limitation, and the correct
  response is to add the endpoint, never a direct Mongo path.
- **A server must be running.** Bootstrap and disaster-recovery tasks that assume no live API are out
  of reach. If that becomes painful, the honest fix is a separate, explicitly-scoped admin tool with
  its own ADR — not a `--local` flag quietly smuggling the in-process variant back in.
- **Two new dependencies** (`commander`, `@clack/prompts`), neither of which the deployed server
  loads: nothing under `src/cli/` is imported by `app.ts`, `server.ts`, or `function.ts`, so the
  function bundle and cold-start path are unchanged.
- **`presentation/` now means two things repo-wide** — HTTP handlers in domain components, terminal
  rendering in `cli`. The layer *semantics* (outermost, maps between the outside world and the layer
  beneath) are identical, but ADR-001's "presentation is HTTP-only" prose now needs reading as a
  statement about domain components specifically.

## Related

- [ADR-001](ADR-001-clean-architecture.md) — Clean layers; the CLI nests them without a `domain/`
- [ADR-002](ADR-002-package-by-component.md) — `src/cli/` is an ordinary component behind a facade
- [ADR-003](ADR-003-dependency-injection.md) — why the CLI uses plain injection instead of the container
- [ADR-004](ADR-004-headless-api-only.md) — the posture this ADR reconciles with: client, not UI
- [ADR-005](ADR-005-boundary-enforcement.md) — the rules that make "HTTP-client-only" mechanically enforced
- [ADR-006](ADR-006-http-delivery-hono.md) — the zod-at-the-edge idiom the CLI mirrors
- [ADR-013](ADR-013-authentication-user-accounts.md) — the JWT/refresh flow the CLI performs
