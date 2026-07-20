# cablegram

A **headless newsletter manager/sender** — a MailChimp-shaped capability exposed as an **HTTP JSON
API, no UI**. Sends via an ESP (Postmark) which owns the fan-out.

Architecture is fixed by the ADRs in [`docs/adrs/`](docs/adrs/README.md); the operative rules live in
[`CLAUDE.md`](CLAUDE.md). Stack: TypeScript · Hono · Inversify · Prisma/MongoDB · Postmark · deploys on
DigitalOcean Functions → Docker · single-tenant, multi-newsletter.

## Quickstart

Requires **Node 24+** (`.nvmrc`) and MongoDB (a replica set — Prisma needs one for transactions;
[Atlas](https://www.mongodb.com/atlas) works, or `mongod --replSet rs0` locally).

```bash
npm install
cp .env.example .env        # then edit values
npm run dev                 # tsx watch, serves on $PORT (default 3000)
```

```bash
curl localhost:3000/health
# {"status":"ok","service":"cablegram"}

curl -H "x-api-key: dev-key-change-me" localhost:3000/v1/...
```

## Scripts

| script | does |
|---|---|
| `npm run dev` | watch-mode server (`tsx`) |
| `npm run build` / `start` | compile to `dist/` / run compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint + **boundary enforcement** (ADR-005) |
| `npm test` | Vitest |
| `npm run prisma:generate` / `prisma:push` | Prisma client / schema sync |

## Layout

```
src/
  shared/        technical modules (config, ids, clock, di, http) — leaves
  app.ts         Hono app assembly
  server.ts      Node entrypoint (Docker / App Platform)
  function.ts    DigitalOcean Functions entrypoint
  <component>/   domain components, added per ADR-011:
                 newsletters · subscriptions · deliverability · templates · campaigns
prisma/schema.prisma
```

Each component and shared module is fronted by an `index.ts` facade; imports go through facades only,
enforced by `eslint-plugin-boundaries` (the lint config *is* the encoded architecture).

## Notes

- `npm audit` reports advisories in **dev-only** tooling (the eslint-plugin-boundaries handlebars
  chain; the vitest/vite/esbuild dev-server chain). None are in the runtime dependencies and none ship
  to production, so they are not force-fixed (that would break linter/test majors).
- DigitalOcean Functions' exact request/response contract is confirmed against DO docs at deploy;
  `src/function.ts` bridges it and is marked accordingly (ADR-009).
