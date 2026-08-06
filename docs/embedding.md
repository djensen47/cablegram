# Embedding cablegram in a host service

Per [ADR-027](adrs/ADR-027-library-entrypoint.md): the package's `"."` export mounts the cablegram
API inside a long-running Node service, alongside that host's own routes. It is one of the two
shapes cablegram runs in ([ADR-028](adrs/ADR-028-containers-only.md)); the other is
standalone, `node dist/server.js` in its own container ([`deployment.md`](deployment.md)).

Reach for it when the host wants one deployable and one hostname. The case it exists for: the
original serverless target could not reach a privately-addressed MongoDB at all (DigitalOcean
Functions components cannot join a VPC), while a long-running service can — and would rather mount
cablegram than run a second service beside it.

## The whole of it

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Db, MongoClient } from 'mongodb';
import { buildContainer, createApp, TYPES, ensureIndexes, ALL_INDEXES } from 'cablegram';

const container = buildContainer({
  ...process.env,
  // MUST include the mount prefix — see below.
  BASE_URL: 'https://app.example.com/newsletter',
});

// Once, at startup: open the pool and materialize the indexes the
// repositories rely on (ADR-012 — the native driver has no `db push`).
await container.get<MongoClient>(TYPES.MongoClient).connect();
await ensureIndexes(container.get<Db>(TYPES.MongoDb), ALL_INDEXES);

const host = new Hono();
host.get('/', (c) => c.text('the host app'));
host.route('/newsletter', createApp(container));

serve({ fetch: host.fetch, port: 8080 });
```

`buildContainer(env)` takes any plain env object and defaults to `process.env`; it validates on the
spot and throws a readable error listing every problem, so a misconfigured host fails at boot rather
than on the first request. The env vars are the same ones `docs/deployment.md` lists — embedding
changes none of them except `BASE_URL`.

Build the container **once, at module scope**, and connect **once**. Per-request construction opens a
new pool per request.

## What is exported — and what isn't

| Symbol | What it's for |
|---|---|
| `createApp(container)` | The mountable `OpenAPIHono` app (an `OpenAPIHono` *is* a `Hono`). |
| `buildContainer(env?)` | The composition root (ADR-003). |
| `TYPES` | DI tokens — you need `MongoClient`, `MongoDb`, and possibly `Config`. |
| `ensureIndexes(db, specs)` | Index bootstrap; idempotent, safe on every restart. |
| `ALL_INDEXES` | Every collection's index specs (ADR-017). |
| `AppConfig`, `AppEnv`, `CollectionIndexes` | Types for the above. |

Nothing else, deliberately. Use cases, entities, repositories and DTOs are not exported: a host that
called `SendCampaign` directly would be a second delivery mechanism, which is the line ADR-004 draws
and [ADR-016](adrs/ADR-016-cli-client.md) enforces from the client side. **Talk to the mounted HTTP
API** — from the same process if you like (`host.request('/newsletter/v1/...')`).

## Two things the host owns

### 1. `BASE_URL` must include the mount prefix

`List-Unsubscribe` URLs are built by concatenating `${BASE_URL}${'/v1/unsubscribe'}`
(`unsubscribe-headers.ts`). Nothing in the app knows where you mounted it, so the prefix has to be in
`BASE_URL`:

```
mounted at /newsletter  →  BASE_URL=https://app.example.com/newsletter
```

Get it wrong and one-click unsubscribe (RFC 8058, [ADR-015](adrs/ADR-015-public-token-unsubscribe.md))
points at a 404. **Leave `BASE_URL` unset and campaign sends silently omit the header entirely** —
no error, no failed send; you find out from a mailbox provider, after a send. Check it before the
first campaign:

```ts
console.log(container.get<AppConfig>(TYPES.Config).baseUrl);  // must end in your mount prefix
```

The same applies to `UNSUBSCRIBE_URL`, `PASSWORD_RESET_URL_BASE` and `MAGIC_LINK_URL_BASE` if you set
them — they're absolute URLs into *your* front end, so they follow your routing, not cablegram's.

### 2. Duplicate middleware and a duplicate `/health`

`createApp` installs its own `requestId` + `requestLogging` middleware and serves `GET /health`
(mounted: `GET /newsletter/health`). A host with top-level request logging will emit **two** lines
per mounted request — one structured cablegram line, one of the host's. This is left as-is
deliberately (ADR-027 §5): the app must keep working standalone (`node dist/server.js`), where it is
the only thing logging, and the cost here is duplicate log lines rather than wrong behaviour. If it
matters, filter on the cablegram line's `"event":"request"` shape, or scope your own logger to paths
outside the mount.

The webhook receiver moves with the mount too: Postmark must be pointed at
`https://app.example.com/newsletter/webhooks/postmark` (Basic-Auth, ADR-008 — outside `/v1`).

## Auth under a mount

Nothing to do. The open-route gate matches the path *relative to the mount* (ADR-027 §4), so
`/newsletter/v1/auth/login` is open and `/newsletter/v1/newsletters` still requires a JWT, exactly as
un-mounted. This is tested in `src/index.test.ts` — it was a real 401-on-everything bug before it was
a test.

## Types

The tarball ships `.d.ts` and the export carries a `types` condition, so a TypeScript consumer on
`moduleResolution: "nodenext"` gets full types with no `@types` package and no `skipLibCheck` tricks.

## Related

- [ADR-027](adrs/ADR-027-library-entrypoint.md) — the decision, and what may go in the barrel.
- [ADR-028](adrs/ADR-028-containers-only.md) — why a container, and what the retired serverless
  target left behind (its constraints, not its adapter).
- [`deployment.md`](deployment.md) — the standalone container shape, env vars, index bootstrap.
- [`releasing.md`](releasing.md) — how a version of this package comes into existence (ADR-026).
