import { OpenAPIHono } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import { TYPES } from './shared/di/index.js';
import { AUTH_TYPES, type AccessTokenService } from './shared/auth/index.js';
import {
  idempotencyKey,
  jwtAuth,
  onError,
  requestId,
  requestLogging,
  type AppEnv,
  type IdempotencyStore,
} from './shared/http/index.js';
import { createAccountsAuthRoutes, createUserRoutes } from './accounts/index.js';
import { createNewsletterRoutes } from './newsletters/index.js';
import { createSubscriptionRoutes } from './subscriptions/index.js';
import { createDeliverabilityRoutes } from './deliverability/index.js';
import { createTemplateRoutes } from './templates/index.js';
import { createCampaignRoutes, createPostmarkWebhookRoutes } from './campaigns/index.js';

/**
 * The open `/v1` endpoints that do **not** require a JWT (ADR-013): first-run
 * setup and the login/refresh/logout exchange — the endpoints a caller reaches
 * before, or in order to obtain, a token. Everything else under `/v1` is gated.
 */
const OPEN_V1_PATHS = new Set([
  '/v1/setup',
  '/v1/auth/login',
  '/v1/auth/refresh',
  '/v1/auth/logout',
]);

/**
 * Assembles the single Hono app from the composition root. The same app runs
 * on DigitalOcean Functions and under a Node server — only the entrypoint
 * differs (ADR-006, ADR-009).
 *
 * An `OpenAPIHono` so the API contract is generated from the same zod schemas
 * that validate requests (ADR-004): `GET /openapi.json` and `GET /health` are
 * open; everything under `/v1` requires a **user Bearer JWT** (ADR-013) except
 * the open setup/auth endpoints; `/v1/users` additionally requires `admin`.
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(onError);
  app.use('*', requestId);
  // Structured, one-line-per-request logging (ADR-009: stdout is the sink).
  // Must run after `requestId` so it can read the id it assigns.
  app.use('*', requestLogging);

  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'User access token (ADR-013). Obtain it from `POST /v1/auth/login`; send it as ' +
      '`Authorization: Bearer <token>`. There is no API key.',
  });

  app.get('/health', (c) => c.json({ status: 'ok', service: 'cablegram' }));

  const v1 = new OpenAPIHono<AppEnv>();
  // Opt-in `Idempotency-Key` support (a client sends the header; a request
  // without one is unaffected) across every mutating POST route in the API.
  v1.use('*', idempotencyKey(container.get<IdempotencyStore>(TYPES.IdempotencyStore)));

  // JWT gate (ADR-013): every `/v1` route requires a valid access token except
  // the open bootstrap/auth endpoints, which need no credential to reach.
  const authenticate = jwtAuth(container.get<AccessTokenService>(AUTH_TYPES.AccessTokenService));
  v1.use('*', async (c, next) =>
    OPEN_V1_PATHS.has(c.req.path) ? next() : authenticate(c, next),
  );

  // Open auth surface: /v1/setup, /v1/auth/{login,refresh,logout}.
  v1.route('/', createAccountsAuthRoutes(container));

  // Authenticated domain routers. Subscriptions are nested under a newsletter
  // (/newsletters/{id}/subscriptions), so they mount on the same base; the two
  // routers' paths do not collide.
  v1.route('/newsletters', createNewsletterRoutes(container));
  v1.route('/newsletters', createSubscriptionRoutes(container));
  v1.route('/suppressions', createDeliverabilityRoutes(container));
  v1.route('/templates', createTemplateRoutes(container));
  v1.route('/campaigns', createCampaignRoutes(container));
  // Admin-only user management (the router self-guards with requireRole('admin')).
  v1.route('/users', createUserRoutes(container));
  app.route('/v1', v1);

  // The Postmark webhook receiver mounts at the TOP LEVEL (not under /v1): it
  // carries its own HTTP Basic-Auth verification (ADR-008) — the sole exception
  // to JWT-only auth (ADR-013).
  app.route('/', createPostmarkWebhookRoutes(container));

  // The generated OpenAPI spec, served openly so the contract is discoverable.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'cablegram',
      version: '0.1.0',
      description:
        'Headless newsletter manager/sender — APIs only (ADR-004). Every route under `/v1` requires ' +
        'a user Bearer JWT (`BearerAuth`; ADR-013) except the open `/v1/setup` and `/v1/auth/*` ' +
        'endpoints; `/v1/users` also requires the `admin` role. `/webhooks/postmark` carries its own ' +
        'Basic-Auth verification instead (ADR-008) and is not part of the `/v1` surface.',
    },
    tags: [
      { name: 'auth', description: 'First-run setup and the login/refresh/logout token exchange (ADR-013).' },
      { name: 'users', description: 'Admin-only user account management (ADR-013).' },
      { name: 'newsletters', description: 'Publications: identity, sender identity, sending domain/DKIM.' },
      { name: 'subscriptions', description: 'Flat, per-newsletter membership — no cross-newsletter Contact (ADR-011).' },
      { name: 'suppressions', description: 'The global, address-keyed deny-list (ADR-011).' },
      { name: 'templates', description: 'Reusable, renderable message shapes.' },
      { name: 'campaigns', description: 'The send integrator: campaign lifecycle, send-now.' },
      { name: 'webhooks', description: 'Provider event receivers, mounted outside the `/v1` JWT surface.' },
    ],
  });

  return app;
}
