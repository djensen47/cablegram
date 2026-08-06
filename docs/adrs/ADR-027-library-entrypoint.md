# ADR-027: A Library Entrypoint — mounting cablegram inside a host service

## Status

Accepted — 2026-08-05.

## Context

[ADR-026](ADR-026-release-and-distribution.md) shipped cablegram to npm with exactly two entrypoints:
`cablegram/function` (the DigitalOcean Functions handler, ADR-009) and the `cablegram` bin
(ADR-016). Its *Related* section stated the reason there was no `"."` entry plainly: **"there is no
library surface to release."** That was true when it was written.

It stopped being true for a mechanical reason, not a design one: **DigitalOcean Functions components
cannot join a VPC**, so a function cannot reach a MongoDB that is only privately addressable. The
deployment ADR-009 assumed is unavailable to a deployment whose database is private. What *can* join
a VPC is a long-running `services:` component — a Dockerfile — and that host wants to mount
cablegram under a path prefix (`/newsletter`) alongside its own routes rather than run it as a
second deployable behind a second hostname.

Nothing in the code was missing. `buildContainer(env = process.env)` already accepts a plain env
object; `createApp(container)` already returns an `OpenAPIHono`, which is a `Hono`, which `route()`
mounts. **Only the packaging prevented it** (issue #44): no `"."` export, no wildcard subpath, no
barrel, and `declaration: false` meant the tarball shipped zero `.d.ts` files.

### Why this is an ADR and not a packaging tweak

Adding a root export commits cablegram to a **supported consumption mode**, and a published export
map is a promise: the symbols named in it are versioned API under ADR-026's conventional commits,
where before them nothing outside `./function` was. ([ADR-028](ADR-028-containers-only.md), decided
alongside this one, retires that Functions entrypoint — so this barrel does not join the export map,
it replaces what was there.) The decision worth recording is not
"add an entry to `exports`" — it is **what that entry may contain**, and the answer has to be a rule
rather than a list, because the pressure to widen it will come one convenient symbol at a time.

The obvious alternatives were both worse:

- **`./server` only** — publish the existing Node-server entrypoint and let the host run cablegram as
  its own VPC-attached service. Smallest commitment, but it answers a different question: the host
  gets a second deployable and a second hostname, not a mounted API. It also does not remove the
  need for types. (`dist/server.js` remains the *standalone* shape — ADR-028 §2 — it is just not
  what an export map is for.)
- **Granular subpaths** (`./app`, `./di`, `./indexes`, `./persistence`) — the same library
  commitment with none of the framing, and it exports the *internal module layout*, so moving a file
  becomes a breaking change. A barrel is the seam; the layout behind it stays ours.

### The defect the packaging was hiding

Mounting exposed a real bug, found while proving this out. The JWT gate in `app.ts` exact-matched
`OPEN_V1_PATHS` against `c.req.path`. Under a mount that path carries the host's prefix
(`/newsletter/v1/auth/login`), which is in no exact-match set — so **every open route returned 401**:
`setup`, the whole login/refresh exchange, password reset, magic link, and the public one-click
unsubscribe. A package that installs, imports, mounts, and then cannot authenticate anybody is not a
solved issue, so the fix belongs to this decision rather than to a follow-up.

## Decision

**cablegram publishes a library entrypoint at `"."` — a barrel over the symbols a host needs to
bootstrap and mount the HTTP API, and nothing else.**

### 1. The barrel is `src/index.ts`, and its contents are a rule

Exported: `createApp` · `buildContainer` · `TYPES` · `ensureIndexes` · `ALL_INDEXES`, plus the types
`AppConfig`, `AppEnv` and `CollectionIndexes`.

The rule: **enough to bootstrap and mount the API, and no reach past the HTTP surface.** Use cases,
entities, repositories, DTOs and component facades stay unexported. This is the same line
[ADR-004](ADR-004-headless-api-only.md) and [ADR-016](ADR-016-cli-client.md) already draw from the
other side — a host that could call `SendCampaign` directly would be a second delivery mechanism, and
the CLI is forbidden from exactly that. Mounting the Hono app is not: it is the *same* delivery
mechanism with a different host, which is why this ADR does not amend ADR-004.

`src/index.test.ts` freezes the export list, so adding a symbol requires editing the list (a `feat:`)
and removing one requires editing it and meaning it (a breaking change).

### 2. `declaration: true`, no `declarationMap`

The tarball ships `.d.ts` for the whole build and the export map carries a `types` condition. No
declaration maps: `files` publishes `dist` only, so a map would point at a `../src/*.ts` that is not
in the tarball.

### 3. One entrypoint, conditioned

```json
"exports": {
  ".":              { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./package.json": "./package.json"
}
```

That is the whole map — `./function` is gone with the target it served (ADR-028), and the `cablegram`
bin (ADR-016) ships alongside it as `bin`, not as an export.

### 4. The open-path gate matches the *mount-relative* path

`OPEN_V1_PATHS` stays an exact-match set of cablegram's own paths — the property that makes a new
open route a deliberate one-line edit. What changes is what it is matched against: `v1Path(c)`
strips the host's mount prefix, recovered from the gate middleware's own registered pattern
(`c.req.routePath`, which Hono flattens to `<prefix>/v1/*` at mount time). An unexpected pattern
falls back to the raw path — the un-mounted behaviour. Both the mounted and un-mounted cases are
tested, including that a *gated* route stays gated under a prefix.

The prefix is **discovered, not configured**. A `createApp(container, { basePath })` option would be
a second place to state the mount, and the two would drift silently — one of them into a 401.

### 5. What the host still owns

Two things a mount does not and cannot fix, documented in [`../embedding.md`](../embedding.md):

- **`BASE_URL` must include the mount prefix.** `unsubscribe-headers.ts` concatenates
  `${baseUrl}${PUBLIC_UNSUBSCRIBE_PATH}` and has no way to know where a host mounted the app. Unset,
  campaign sends **silently omit** `List-Unsubscribe` (ADR-015) rather than failing — a
  misconfiguration discovered after a send, not before.
- **`createApp` brings its own `requestId` + `requestLogging` middleware and its own `GET /health`.**
  A host with top-level logging double-logs mounted requests. Left as-is deliberately: making them
  opt-out would widen the API surface in the same change that first freezes it, and the cost is
  duplicate log lines, not incorrect behaviour.

## Consequences

- The deployment blocked by DO Functions' VPC restriction is unblocked. Combined with ADR-028, the
  package now describes exactly one thing — an app you host — in two shapes that differ only in who
  owns the process.
- **The public API surface is now something to defend.** Five values and three types are versioned
  promises; the frozen-list test is the mechanism, and every widening request should be answered with
  §1's rule rather than with the convenience of the moment.
- `.d.ts` output makes some previously-invisible type errors visible at build time (declaration
  emit is stricter about inferred types crossing module boundaries). That is a cost paid once.
- Consumers gain a second way to be wrong: mounting at a prefix while `BASE_URL` says otherwise.
  Documented, not prevented — the only real prevention is a send-time check, which belongs to an
  ADR-015 revision if the silent omission ever bites.
- The embedded host does not get the `server.ts` niceties (`.env` loading, the listen log). It
  bootstraps explicitly — connect the pool, `ensureIndexes`, mount — which is three lines and is what
  makes the ordering visible to whoever operates it.

## Related

- [ADR-026](ADR-026-release-and-distribution.md) — release & distribution; its *Related* note that
  the package exposes no `"."` entry is superseded by this ADR (the reason it gave — "there is no
  library surface" — is what changed).
- [ADR-028](ADR-028-containers-only.md) — decided with this one: containers only, and the retirement
  of the `./function` entrypoint this barrel replaces.
- [ADR-009](ADR-009-deployment-digitalocean-functions.md) — superseded as a target, but still the
  source of the module-scope pool + index bootstrap an embedding host must reproduce.
- [ADR-004](ADR-004-headless-api-only.md) — headless: the mounted thing is the HTTP API, which is why
  the barrel stops at it.
- [ADR-016](ADR-016-cli-client.md) — the same boundary from the client side (a consumer speaks the
  API; it does not import the domain).
- [ADR-015](ADR-015-public-token-unsubscribe.md) — why `BASE_URL` and the open unsubscribe path both
  matter under a mount.
- [`../embedding.md`](../embedding.md) — the runbook for a host service.
- Issue [#44](https://github.com/djensen47/cablegram/issues/44).
