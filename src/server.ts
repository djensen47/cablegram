import 'reflect-metadata';
import { serve } from '@hono/node-server';
import type { Db, MongoClient } from 'mongodb';
import { buildContainer, TYPES } from './shared/di/index.js';
import type { AppConfig } from './shared/config/index.js';
import { ensureIndexes } from './shared/persistence/index.js';
import { createApp } from './app.js';

// Node-server entrypoint — used under Docker / DigitalOcean App Platform
// (ADR-009). For DO Functions, see function.ts.

// Load .env in local dev if present; in deployed envs the platform injects vars.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the real environment
}

const container = buildContainer();
const app = createApp(container);
const { port } = container.get<AppConfig>(TYPES.Config);

// Open the pool once at module scope (ADR-009: connect once, reuse across
// requests) and materialize the indexes the repositories rely on (ADR-012:
// the native driver has no `prisma db push`, so the app owns index creation).
await container.get<MongoClient>(TYPES.MongoClient).connect();
await ensureIndexes(container.get<Db>(TYPES.MongoDb));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`cablegram listening on :${info.port}`);
});
