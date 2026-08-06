# Deployment

Per [ADR-028](adrs/ADR-028-containers-only.md): cablegram runs as a **long-running container**, in
one of two shapes — standalone (`src/server.ts`, the `Dockerfile`'s `CMD`) or mounted inside a host
service ([ADR-027](adrs/ADR-027-library-entrypoint.md)). Both are the same Hono app; they differ only
in who owns the process. The DigitalOcean Functions target is retired — see the end of this file.

The runtime constraints still come from [ADR-009](adrs/ADR-009-deployment-digitalocean-functions.md),
which is superseded as a *target* but not as a discipline.

## Docker (standalone)

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
startup** — `server.ts` connects the pool and calls it before serving, and an embedding host makes
the same two calls itself ([`embedding.md`](embedding.md)). `createIndexes` is idempotent, so a
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

## Mounted inside a host service

The other supported shape ([ADR-027](adrs/ADR-027-library-entrypoint.md)): a long-running host
imports the package and mounts the app under a path prefix, instead of running it as its own
container. Same app, same constraints — the host just owns the process. See
[`embedding.md`](embedding.md).

## What happened to DigitalOcean Functions

Retired ([ADR-028](adrs/ADR-028-containers-only.md)). `src/function.ts` and `project.yml` are gone,
and so is the `cablegram/function` export. Three reasons, the last decisive: the config was never
verified against a real `doctl serverless deploy`; the in-repo build was already abandoned for App
Platform's `build.sh` restriction (ADR-026); and **DO Functions components cannot join a VPC**, so
they cannot reach a privately-addressed MongoDB.

**ADR-009's runtime constraints did not go with it** — stateless, no background workers, no long
in-request loops, no local disk, config from env, pool at module scope. A container is replicated and
restarted, so they are still binding; ADR-028 §3 re-derives them.

## CI

`.github/workflows/ci.yml` runs on every PR (and on push to `main`): `npm ci` → `npm run typecheck`
→ `npm run lint` (includes `eslint-plugin-boundaries`, ADR-005) → `npm test` (Vitest, in-memory
repositories only — no live database, ADR-003). There is no `prisma generate` step — the native
driver needs no codegen (ADR-012).
