# syntax=docker/dockerfile:1

# cablegram — Docker runtime image (ADR-009: the guaranteed deployment
# target; DigitalOcean Functions is a best-effort second target, see
# docs/deployment.md).
#
# Multi-stage: install -> `prisma generate` -> `tsc` build -> slim runtime
# that only carries production dependencies + the generated Prisma Client +
# compiled JS. Runs `node dist/server.js` via @hono/node-server.
#
# NOTE (ADR-007): MongoDB has no migration files — schema sync is
# `prisma db push`, run against the target database out-of-band (Atlas
# provisions the replica set separately). This image never runs `db push`.

ARG NODE_VERSION=24

# ---- deps: full dependency graph (needed for the TypeScript/Prisma build tools) ----
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: generate the Prisma Client and compile TypeScript ----
FROM deps AS build
COPY prisma ./prisma
# `prisma generate` only reads the schema file — it needs no DB connection,
# so DATABASE_URL is irrelevant at build time.
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps only + generated client + compiled output ----
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# `npm ci --omit=dev` reinstalls the plain `@prisma/client` package but not
# the generated client code (that's produced by `prisma generate`, a dev-time
# step) — copy the generated output over explicitly.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

# node:*-slim images ship a non-root `node` user; run as it.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
