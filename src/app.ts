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
import {
  createSubscriptionRoutes,
  createPublicUnsubscribeRoutes,
  PUBLIC_UNSUBSCRIBE_PATH,
} from './subscriptions/index.js';
import { createDeliverabilityRoutes } from './deliverability/index.js';
import { createTemplateRoutes } from './templates/index.js';
import {
  createCampaignRoutes,
  createPostmarkWebhookRoutes,
  createUnhandledEventRoutes,
} from './campaigns/index.js';

/**
 * The open `/v1` endpoints that do **not** require a JWT (ADR-013/014): first-run
 * setup, the login/refresh/logout exchange, and the password-reset + magic-link
 * flows — the endpoints a caller reaches before, or in order to obtain, a token.
 * Everything else under `/v1` is gated. This is an exact-match set: every new
 * open route must be listed here explicitly. Matched against `v1Path(c)` — the
 * path with any host mount prefix removed — not the raw request path.
 */
const OPEN_V1_PATHS = new Set([
  '/v1/setup',
  '/v1/auth/login',
  '/v1/auth/refresh',
  '/v1/auth/logout',
  '/v1/auth/password-reset',
  '/v1/auth/password-reset/confirm',
  '/v1/auth/magic-link',
  '/v1/auth/magic-link/consume',
  // Public, token-authenticated unsubscribe + RFC 8058 one-click (ADR-015): the
  // recipient (or their mail client) reaches this with no session, authenticated
  // by the HMAC token in the query, not a JWT.
  PUBLIC_UNSUBSCRIBE_PATH,
]);

/**
 * The request path as cablegram's own routing sees it — the host's mount prefix
 * removed (ADR-027).
 *
 * `OPEN_V1_PATHS` is an exact-match set of *cablegram's* paths, but an embedding
 * host mounts this app under a prefix of its choosing, and `c.req.path` then
 * carries that prefix (`/newsletter/v1/auth/login`). Matching the raw path would
 * close every open route the moment the app is mounted anywhere but the root —
 * nobody could log in, and RFC 8058 one-click unsubscribe would 401.
 *
 * Hono flattens a mounted app's routes onto the host's router, so this
 * middleware's own registered pattern (`routePath`) carries the same prefix and
 * ends in the `'*'` it was registered with: `/newsletter/v1/*`. Everything
 * before that `'*'` is the absolute base of the `/v1` mount; what follows it in
 * the request path is the route within. If the pattern is ever not a wildcard
 * mount, fall back to the raw path — the un-mounted behaviour.
 */
function v1Path(c: { req: { path: string; routePath: string } }): string {
  const pattern = c.req.routePath;
  if (!pattern.endsWith('/*')) return c.req.path;
  return `/v1/${c.req.path.slice(pattern.length - 1)}`;
}

/**
 * Assembles the single Hono app from the composition root. The same app runs
 * standalone under a Node server and mounted inside a host service — only the
 * entrypoint differs (ADR-006, ADR-028).
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
    OPEN_V1_PATHS.has(v1Path(c)) ? next() : authenticate(c, next),
  );

  // Open auth surface: /v1/setup, /v1/auth/{login,refresh,logout}.
  v1.route('/', createAccountsAuthRoutes(container));

  // Authenticated domain routers. Subscriptions are nested under a newsletter
  // (/newsletters/{id}/subscriptions), so they mount on the same base; the two
  // routers' paths do not collide.
  v1.route('/newsletters', createNewsletterRoutes(container));
  v1.route('/newsletters', createSubscriptionRoutes(container));
  // Public unsubscribe (open; listed in OPEN_V1_PATHS above). Mounted at
  // /v1/unsubscribe — a fixed path, so the exact-match open-path gate covers it.
  v1.route('/unsubscribe', createPublicUnsubscribeRoutes(container));
  v1.route('/suppressions', createDeliverabilityRoutes(container));
  v1.route('/templates', createTemplateRoutes(container));
  v1.route('/campaigns', createCampaignRoutes(container));
  // The operator's view of the webhook receiver (GET /v1/webhooks/unhandled).
  // JWT-gated like every other /v1 route — only the *receiver* itself sits
  // outside, at the top level, with its own Basic-Auth (ADR-008).
  v1.route('/webhooks', createUnhandledEventRoutes(container));
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
      { name: 'webhooks', description: 'The provider event receiver (outside the `/v1` JWT surface, Basic-Auth’d) and the operator’s read-side view of what it could not act on.' },
    ],
  });

  return app;
}
