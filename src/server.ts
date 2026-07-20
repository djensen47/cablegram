import 'reflect-metadata';
import { serve } from '@hono/node-server';
import { buildContainer, TYPES } from './shared/di/index.js';
import type { AppConfig } from './shared/config/index.js';
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

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`cablegram listening on :${info.port}`);
});
