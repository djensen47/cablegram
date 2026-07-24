import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import { BadRequestError, errorResponse, throwOnInvalid, type AppEnv } from '../../shared/http/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import { InvalidUnsubscribeTokenError } from '../domain/errors.js';
import type { PublicUnsubscribe } from '../application/public-unsubscribe.js';

/**
 * The fixed, public path the `List-Unsubscribe` header and body link point at
 * (ADR-015). Kept as one exported constant so the send path (which builds the
 * URL), the router mount, and `OPEN_V1_PATHS` (which opens it) never drift.
 */
export const PUBLIC_UNSUBSCRIBE_PATH = '/v1/unsubscribe';

const UnsubscribeQuerySchema = z.object({
  newsletterId: z.string().min(1).openapi({
    param: { name: 'newsletterId', in: 'query' },
    example: '9f21-2b0e5d8a1c33-4a7f2c1e-6b1a',
  }),
  subscriptionId: z.string().min(1).openapi({
    param: { name: 'subscriptionId', in: 'query' },
    example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33',
  }),
  token: z.string().min(1).openapi({
    param: { name: 'token', in: 'query' },
    description: 'The stateless HMAC unsubscribe token bound to this (newsletter, subscription).',
  }),
});

const badRequestResponse = errorResponse('Invalid or expired unsubscribe link');

const getUnsubscribeRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['subscriptions'],
  summary: 'Public unsubscribe (browser link)',
  description:
    'Open (ADR-015): no JWT — the query `token` (HMAC-bound to the newsletter + subscription) is the ' +
    'credential. Flips the subscription to `unsubscribed` (idempotent), then either redirects to the ' +
    'configured landing page (with the address on the query string) or renders a small confirmation ' +
    'page. Does not add the address to the global suppression list.',
  request: { query: UnsubscribeQuerySchema },
  responses: {
    200: { description: 'A minimal HTML confirmation (when redirect is not configured)' },
    302: { description: 'Redirect to the configured landing page after unsubscribing' },
    400: badRequestResponse,
  },
});

const postUnsubscribeRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['subscriptions'],
  summary: 'RFC 8058 one-click unsubscribe',
  description:
    'Open (ADR-015): the `List-Unsubscribe-Post` one-click target. A mail client POSTs here with body ' +
    '`List-Unsubscribe=One-Click`; the query `token` authenticates. Always returns 200 (no redirect) — ' +
    'mail clients do not render a body.',
  request: { query: UnsubscribeQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ status: z.literal('unsubscribed') }) } },
      description: 'The subscription is unsubscribed (or already was)',
    },
    400: badRequestResponse,
  },
});

/** A tiny, self-contained, unbranded confirmation page (no external assets). */
function confirmationPage(email: string | null): string {
  const who = email ? ` (${escapeHtml(email)})` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1c1e21; }
  .card { background: #fff; padding: 2.5rem 2rem; border-radius: 12px; max-width: 26rem;
    text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #4b4f56; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>You've been unsubscribed</h1>
    <p>This address${who} will no longer receive this newsletter.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Domain errors carry no HTTP status (ADR-001); translate at the edge.
function rethrow(err: unknown): never {
  if (err instanceof InvalidUnsubscribeTokenError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

/**
 * The public unsubscribe surface (ADR-015), mounted at `/v1/unsubscribe` and
 * listed in `OPEN_V1_PATHS` so it bypasses the JWT gate. A `GET` serves the
 * human-clicked body link (redirect or confirmation page); a `POST` serves the
 * RFC 8058 one-click target. Both authenticate with the query `token` only.
 */
export function createPublicUnsubscribeRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(getUnsubscribeRoute, async (c) => {
    const { newsletterId, subscriptionId, token } = c.req.valid('query');
    const config = container.get<AppConfig>(SHARED_TYPES.Config);
    let email: string | null;
    try {
      const subscription = await container
        .get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe)
        .execute(newsletterId, subscriptionId, token);
      email = subscription?.email ?? null;
    } catch (err) {
      rethrow(err);
    }

    if (config.unsubscribe.redirectEnabled && config.unsubscribe.redirectUrl) {
      const target = new URL(config.unsubscribe.redirectUrl);
      if (email) target.searchParams.set('email', email);
      return c.redirect(target.toString(), 302);
    }
    return c.html(confirmationPage(email), 200);
  });

  app.openapi(postUnsubscribeRoute, async (c) => {
    const { newsletterId, subscriptionId, token } = c.req.valid('query');
    try {
      await container
        .get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe)
        .execute(newsletterId, subscriptionId, token);
      return c.json({ status: 'unsubscribed' } as const, 200);
    } catch (err) {
      rethrow(err);
    }
  });

  return app;
}
