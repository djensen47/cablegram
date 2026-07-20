# Deployment

Per [ADR-009](adrs/ADR-009-deployment-digitalocean-functions.md): one Hono app, two entrypoints. Docker
(`src/server.ts`) is the **shipped, guaranteed path**. DigitalOcean Functions (`src/function.ts`,
`project.yml`) is a **best-effort second target** — documented honestly below, including what's still
open, rather than asserted as working.

## Docker (shipped)

```bash
docker build -t cablegram .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="mongodb://host.docker.internal:27017/cablegram?replicaSet=rs0" \
  -e API_KEYS="dev-key-change-me" \
  -e POSTMARK_SERVER_TOKEN="pm-server-token" \
  -e POSTMARK_WEBHOOK_SECRET="change-me" \
  cablegram

curl localhost:3000/health
```

**Build stages** (`Dockerfile`): `deps` (`npm ci`, full graph) → `build` (`prisma generate` against the
schema file only — no DB connection needed — then `tsc` via `npm run build`) → `runtime`
(`node:24-slim`, `npm ci --omit=dev`, the generated `.prisma` client copied in from `build`, `dist/`
copied in, runs as the image's non-root `node` user, `CMD node dist/server.js`).

**Prisma engine for the container** (ADR-007): `prisma/schema.prisma`'s generator pins
`binaryTargets = ["native", "debian-openssl-3.0.x"]` — `debian-openssl-3.0.x` matches `node:24-slim`
(Debian Bookworm, OpenSSL 3.0.x), `native` keeps local dev working unmodified on any host OS. We did
**not** adopt `engineType = "client"` (the Rust-free, driver-adapter query engine, GA since Prisma
6.16): as of Prisma 6.19 its documented driver adapters are for relational connectors (`pg`, `mysql2`,
`libsql`, ...) — there is no documented MongoDB driver adapter, so it isn't a verified swap for this
connector. Revisit if Prisma documents MongoDB support.

**Schema sync** (ADR-007): MongoDB has no migration files. `npm run prisma:push` (`prisma db push`)
syncs the Prisma schema to the target database. This is run **out-of-band against the target
database**, by a human/CI step with `DATABASE_URL` pointed at it — **the image never runs it**, so a
container restart/redeploy can never accidentally alter schema. The database itself (a MongoDB replica
set — Prisma's Mongo connector requires one for transactions) is provisioned separately (e.g. MongoDB
Atlas); this repo does not provision infrastructure.

**Connection pooling** (ADR-009): the `PrismaClient` is bound `inSingletonScope()` in the composition
root (`src/shared/di/container.ts`), and `buildContainer()` runs once at module scope in both
entrypoints — so the pool is created once per warm process/instance, not per request.

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
   (Prisma's generated client *and* its native query-engine binary, Inversify, Hono, zod, handlebars,
   `@hono/*`) is not confirmed to fit. Prisma's query-engine binary alone is commonly tens of MB.
2. **Build model mismatch.** DO's documented Node.js build runs `npm install` (then `npm run build`,
   if present) **inside the action's own directory**. That fits a single-file action; it does not map
   cleanly onto a package-by-component monorepo whose action is really "the whole compiled app plus
   its shared `node_modules`." `project.yml` above assumes the repo root can serve as that build
   context, which DigitalOcean's docs don't explicitly confirm or deny for this project layout.
3. **Native binary compilation.** DO's docs state native/binary dependencies need
   `doctl serverless deploy --remote-build` (their words: "local builds are not supported" for
   platform-specific compiled deps) — relevant to Prisma's native query engine. Untested here.

Given these three open items, **do not rely on the DO Functions path without first running
`doctl serverless deploy --remote-build --verbose-build` against a scratch namespace and confirming the
resulting action boots and serves `/health`.** If it doesn't fit, Docker remains the shipped path with
no loss of functionality — the two entrypoints share every line of business logic (ADR-009).

## CI

`.github/workflows/ci.yml` runs on every PR (and on push to `main`): `npm ci` → `npx prisma generate`
(schema-only, no DB) → `npm run typecheck` → `npm run lint` (includes `eslint-plugin-boundaries`,
ADR-005) → `npm test` (Vitest, in-memory repositories only — no live database, per the locked test
convention in `docs/BUILD-PLAN.md`).
