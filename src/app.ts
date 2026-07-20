import { OpenAPIHono } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import { TYPES } from './shared/di/index.js';
import type { AppConfig } from './shared/config/index.js';
import { apiKeyAuth, onError, requestId, type AppEnv } from './shared/http/index.js';
import { createNewsletterRoutes } from './newsletters/index.js';
import { createSubscriptionRoutes } from './subscriptions/index.js';
import { createDeliverabilityRoutes } from './deliverability/index.js';
import { createTemplateRoutes } from './templates/index.js';
import { createCampaignRoutes, createPostmarkWebhookRoutes } from './campaigns/index.js';

/**
 * Assembles the single Hono app from the composition root. The same app runs
 * on DigitalOcean Functions and under a Node server — only the entrypoint
 * differs (ADR-006, ADR-009).
 *
 * An `OpenAPIHono` so the API contract is generated from the same zod schemas
 * that validate requests (ADR-004): `GET /openapi.json` is open, `GET /health`
 * is open, everything under `/v1` sits behind API-key auth (ADR-010).
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const config = container.get<AppConfig>(TYPES.Config);

  const app = new OpenAPIHono<AppEnv>();
  app.onError(onError);
  app.use('*', requestId);

  app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Api-Key',
    description: 'Single-tenant API key (ADR-004, ADR-010).',
  });

  app.get('/health', (c) => c.json({ status: 'ok', service: 'cablegram' }));

  // Domain component routers mount onto `v1` (behind API-key auth) as they are
  // added; webhook receivers mount at the top level with their own verification.
  const v1 = new OpenAPIHono<AppEnv>();
  v1.use('*', apiKeyAuth(config.apiKeys));
  v1.route('/newsletters', createNewsletterRoutes(container));
  // Subscriptions are nested under a newsletter (/newsletters/{id}/subscriptions),
  // so they mount on the same base; the two routers' paths do not collide.
  v1.route('/newsletters', createSubscriptionRoutes(container));
  v1.route('/suppressions', createDeliverabilityRoutes(container));
  v1.route('/templates', createTemplateRoutes(container));
  v1.route('/campaigns', createCampaignRoutes(container));
  app.route('/v1', v1);

  // The Postmark webhook receiver mounts at the TOP LEVEL (not behind the /v1
  // API key): it carries its own HTTP Basic-Auth verification (ADR-008).
  app.route('/', createPostmarkWebhookRoutes(container));

  // The generated OpenAPI spec, served openly so the contract is discoverable.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'cablegram',
      version: '0.1.0',
      description: 'Headless newsletter manager/sender — APIs only.',
    },
  });

  return app;
}
