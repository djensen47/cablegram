# cablegram

A **headless newsletter manager/sender** — a MailChimp-shaped capability exposed as an **HTTP JSON
API, no UI**. Sends via an ESP (Postmark) which owns the fan-out.

Architecture is fixed by the ADRs in [`docs/adrs/`](docs/adrs/README.md); the operative rules live in
[`CLAUDE.md`](CLAUDE.md). Stack: TypeScript · Hono · Inversify · MongoDB (native driver) · Postmark ·
deploys on DigitalOcean Functions → Docker · single-tenant, multi-newsletter.

## Quickstart

Requires **Node 24+** (`.nvmrc`) and MongoDB. A plain standalone `mongod` is enough — cablegram does
only single-document, no-transaction writes, so no replica set is needed (ADR-012);
[Atlas](https://www.mongodb.com/atlas) works too.

```bash
npm install
cp .env.example .env        # then edit values
npm run dev                 # tsx watch, serves on $PORT (default 3000)
```

```bash
curl localhost:3000/health
# {"status":"ok","service":"cablegram"}

# Bootstrap the first admin (open, one-time), then log in for a Bearer token (ADR-013):
curl -X POST localhost:3000/v1/setup \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"a-strong-password"}'
TOKEN=$(curl -sX POST localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"a-strong-password"}' | jq -r .accessToken)
curl -H "authorization: Bearer $TOKEN" localhost:3000/v1/...
```

## Scripts

| script | does |
|---|---|
| `npm run dev` | watch-mode server (`tsx`) |
| `npm run build` / `start` | compile to `dist/` / run compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint + **boundary enforcement** (ADR-005) |
| `npm test` | Vitest (fast, in-memory repositories) |
| `npm run test:integration` | Vitest repository contract tests against a real `mongod` |

## Layout

```
src/
  shared/        technical modules (config, ids, clock, di, http) — leaves
  app.ts         Hono app assembly
  server.ts      Node entrypoint (Docker / App Platform)
  function.ts    DigitalOcean Functions entrypoint
  <component>/   domain components, added per ADR-011:
                 newsletters · subscriptions · deliverability · templates · campaigns
```

Each component and shared module is fronted by an `index.ts` facade; imports go through facades only,
enforced by `eslint-plugin-boundaries` (the lint config *is* the encoded architecture).

## Deployment

Docker is the shipped, guaranteed target; DigitalOcean Functions is a best-effort second target. See
[`docs/deployment.md`](docs/deployment.md) for build details, the index-bootstrap note, and what's
still unverified on the Functions path.

```bash
docker build -t cablegram .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="mongodb://host.docker.internal:27017/cablegram" \
  -e JWT_SECRET="change-me-to-a-long-random-secret-at-least-32-chars" \
  -e POSTMARK_SERVER_TOKEN="pm-server-token" \
  -e POSTMARK_WEBHOOK_SECRET="change-me" \
  cablegram
# (not `--env-file .env` — Docker's env-file loader doesn't strip the quotes
# in .env.example's values, unlike Node's process.loadEnvFile used by `npm run dev`)
```

CI (`.github/workflows/ci.yml`) runs `typecheck`/`lint`/`test` on every PR.

## Notes

- `npm audit` reports advisories in **dev-only** tooling (the eslint-plugin-boundaries handlebars
  chain; the vitest/vite/esbuild dev-server chain). None are in the runtime dependencies and none ship
  to production, so they are not force-fixed (that would break linter/test majors).
- DigitalOcean Functions' exact request/response contract is confirmed against DO docs at deploy;
  `src/function.ts` bridges it and is marked accordingly (ADR-009).
