import { Hono } from 'hono';
import type { Container } from 'inversify';
import { TYPES } from './shared/di/index.js';
import type { AppConfig } from './shared/config/index.js';
import { apiKeyAuth, onError, requestId, type AppEnv } from './shared/http/index.js';

/**
 * Assembles the single Hono app from the composition root. The same app runs
 * on DigitalOcean Functions and under a Node server — only the entrypoint
 * differs (ADR-006, ADR-009).
 *
 * Domain component routers mount onto `v1` (behind API-key auth) as they are
 * added; webhook receivers mount at the top level with their own verification.
 */
export function createApp(container: Container): Hono<AppEnv> {
  const config = container.get<AppConfig>(TYPES.Config);

  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('*', requestId);

  app.get('/health', (c) => c.json({ status: 'ok', service: 'cablegram' }));

  const v1 = new Hono<AppEnv>();
  v1.use('*', apiKeyAuth(config.apiKeys));
  // v1.route('/newsletters', createNewsletterRoutes(container));  ← added per component
  app.route('/v1', v1);

  return app;
}
