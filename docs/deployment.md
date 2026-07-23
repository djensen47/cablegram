# Deployment

Per [ADR-009](adrs/ADR-009-deployment-digitalocean-functions.md): one Hono app, two entrypoints. Docker
(`src/server.ts`) is the **shipped, guaranteed path**. DigitalOcean Functions (`src/function.ts`,
`project.yml`) is a **best-effort second target** — documented honestly below, including what's still
open, rather than asserted as working.

## Docker (shipped)

```bash
docker build -t cablegram .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="mongodb://host.docker.internal:27017/cablegram" \
  -e JWT_SECRET="change-me-to-a-long-random-secret-at-least-32-chars" \
  -e POSTMARK_SERVER_TOKEN="pm-server-token" \
  -e POSTMARK_WEBHOOK_SECRET="change-me" \
  cablegram

curl localhost:3000/health
```

**Build stages** (`Dockerfile`): `deps` (`npm ci`, full graph) → `build` (`tsc` via `npm run build`)
→ `runtime` (`node:24-slim`, `npm ci --omit=dev`, `dist/` copied in, runs as the image's non-root
`node` user, `CMD node dist/server.js`). With the native MongoDB driver (ADR-012) there is **no
codegen step and no native engine binary** — nothing to generate before `tsc`, nothing platform-
specific to copy between stages or pin with `binaryTargets`. The image is correspondingly smaller.

**Schema / index sync** (ADR-012): MongoDB has no migration files, and there is no `prisma db push`
anymore. The app owns index creation: `ensureIndexes(db)` (`src/shared/persistence`) runs **once at
startup** in each entrypoint (`server.ts` connects the pool and calls it before serving;
`function.ts` runs it lazily on the first warm invocation). `createIndexes` is idempotent, so a
restart/redeploy re-asserting the same indexes is a no-op. The database itself is provisioned
separately (e.g. MongoDB Atlas, or a plain `mongod`); this repo does not provision infrastructure.
**No replica set is required** — every write is a single document and nothing uses transactions
(ADR-012), so a standalone `mongod` is sufficient (Atlas works too).

**Connection pooling** (ADR-009): one `MongoClient` is bound `inSingletonScope()` in the composition
root (`src/shared/di/container.ts`) with a derived `Db` handle, and `buildContainer()` runs once at
module scope in both entrypoints — so the pool is created and connected once per warm process/
instance, not per request.

**Health check**: the image's `HEALTHCHECK` and the app's `GET /health` route are what "serves traffic"
means for this image — no separate readiness endpoint.

## DigitalOcean Functions (best-effort, unverified)

`project.yml` declares a single `cablegram/api` raw web action wrapping the whole app, matching
`src/function.ts`'s existing `__ow_*`-field contract (DigitalOcean's raw web-action invocation shape,
per DO's Functions reference docs — as opposed to non-raw web actions, which parse the body into
top-level `args` by content type). `runtime: nodejs:24`, `web: raw`, generous per-invocation
`limits.timeout`/`limits.memory` (Functions are ephemeral, not long-running — ADR-009).

**What's genuinely unverified** (this file documents the approach; it has not been deployed):

1. **Size.** DigitalOcean Functions cap a deployed action at **48 MB**. This app's dependency graph
   (the MongoDB native driver, Inversify, Hono, zod, handlebars, `@hono/*`) is not confirmed to fit,
   though it is lighter now that Prisma's generated client and native query-engine binary are gone
   (ADR-012) — the largest, most serverless-hostile dependency has been removed.
2. **Build model mismatch.** DO's documented Node.js build runs `npm install` (then `npm run build`,
   if present) **inside the action's own directory**. That fits a single-file action; it does not map
   cleanly onto a package-by-component monorepo whose action is really "the whole compiled app plus
   its shared `node_modules`." `project.yml` above assumes the repo root can serve as that build
   context, which DigitalOcean's docs don't explicitly confirm or deny for this project layout.

Given these open items, **do not rely on the DO Functions path without first running
`doctl serverless deploy --remote-build --verbose-build` against a scratch namespace and confirming the
resulting action boots and serves `/health`.** If it doesn't fit, Docker remains the shipped path with
no loss of functionality — the two entrypoints share every line of business logic (ADR-009).

## CI

`.github/workflows/ci.yml` runs on every PR (and on push to `main`): `npm ci` → `npm run typecheck`
→ `npm run lint` (includes `eslint-plugin-boundaries`, ADR-005) → `npm test` (Vitest, in-memory
repositories only — no live database, per the locked test convention in `docs/BUILD-PLAN.md`). There
is no `prisma generate` step anymore — the native driver needs no codegen (ADR-012).
