# syntax=docker/dockerfile:1

# cablegram — Docker runtime image (ADR-009: the guaranteed deployment
# target; DigitalOcean Functions is a best-effort second target, see
# docs/deployment.md).
#
# Multi-stage: install -> `tsc` build -> slim runtime that only carries
# production dependencies + compiled JS. Runs `node dist/server.js` via
# @hono/node-server.
#
# NOTE (ADR-012): persistence is the official MongoDB Node.js driver — no
# codegen step, no native query-engine binary. Indexes are created by the app
# itself at startup (`ensureIndexes`, run once at module scope), not by an
# out-of-band schema-sync step.

ARG NODE_VERSION=24

# ---- deps: full dependency graph (needed for the TypeScript build tools) ----
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps only + compiled output ----
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# node:*-slim images ship a non-root `node` user; run as it.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
