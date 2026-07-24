import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import { BadRequestError, errorResponse, throwOnInvalid, type AppEnv } from '../../shared/http/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import { InvalidUnsubscribeTokenError } from '../domain/errors.js';
import type { PublicUnsubscribe } from '../application/public-unsubscribe.js';

/**
 * The fixed, public path the `List-Unsubscribe` link points at (ADR-015). Kept
 * as one exported constant so the send path (which builds the URL), the router
 * mount, and `OPEN_V1_PATHS` (which opens it) never drift.
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
  summary: 'Built-in unsubscribe page (browser link)',
  description:
    'Open (ADR-015): serves a small self-contained HTML page that POSTs back to this same endpoint to ' +
    'unsubscribe. **This GET does not change any state** — the mutation happens on the POST — so link ' +
    'scanners that pre-fetch the URL cannot unsubscribe anyone. When an operator `UNSUBSCRIBE_URL` is ' +
    'configured, the email links there instead and this page is just a fallback.',
  request: { query: UnsubscribeQuerySchema },
  responses: {
    200: { description: 'The self-contained unsubscribe confirmation page (text/html)' },
    400: badRequestResponse,
  },
});

const postUnsubscribeRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['subscriptions'],
  summary: 'Perform the unsubscribe (RFC 8058 one-click + page/operator POST)',
  description:
    'Open (ADR-015): the query `token` (HMAC-bound to the newsletter + subscription) authenticates — ' +
    'no JWT. Flips the subscription to `unsubscribed` (idempotent) and returns JSON. This is the target ' +
    'for the RFC 8058 one-click header, the built-in page’s script, and an operator page. Does not add ' +
    'the address to the global suppression list.',
  request: { query: UnsubscribeQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('unsubscribed'),
            email: z.string().nullable(),
          }),
        },
      },
      description: 'The subscription is unsubscribed (or already was)',
    },
    400: badRequestResponse,
  },
});

/**
 * The built-in unsubscribe page: a single self-contained document (inlined CSS +
 * vanilla JS, no external assets). It reads the token params from its own URL,
 * and on the confirm button POSTs to this same endpoint, then swaps in the
 * result. The POST is what unsubscribes — loading the page does nothing.
 */
function unsubscribePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1c1e21; }
  @media (prefers-color-scheme: dark) { body { background: #17181a; color: #e7e9ea; }
    .card { background: #202124 !important; box-shadow: none !important; } .muted { color: #9aa0a6 !important; } }
  .card { background: #fff; padding: 2.5rem 2rem; border-radius: 12px; max-width: 26rem; width: calc(100% - 2rem);
    box-sizing: border-box; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; line-height: 1.5; }
  .muted { color: #4b4f56; }
  button { font: inherit; font-weight: 600; color: #fff; background: #2563eb; border: 0;
    border-radius: 8px; padding: .7rem 1.4rem; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
</style>
</head>
<body>
  <div class="card" id="card">
    <h1>Unsubscribe</h1>
    <p class="muted">Click below to stop receiving this newsletter.</p>
    <button id="go" type="button">Unsubscribe</button>
  </div>
  <script>
    (function () {
      var card = document.getElementById('card');
      var btn = document.getElementById('go');
      function show(title, message) {
        card.innerHTML = '<h1></h1><p class="muted"></p>';
        card.querySelector('h1').textContent = title;
        card.querySelector('p').textContent = message;
      }
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Unsubscribing…';
        fetch('/v1/unsubscribe' + window.location.search, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        }).then(function (res) {
          if (!res.ok) throw new Error('failed');
          return res.json();
        }).then(function (data) {
          var who = data && data.email ? ' (' + data.email + ')' : '';
          show("You've been unsubscribed", 'This address' + who + ' will no longer receive this newsletter.');
        }).catch(function () {
          show('Something went wrong', 'This unsubscribe link may be invalid or expired.');
        });
      });
    })();
  </script>
</body>
</html>`;
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
 * listed in `OPEN_V1_PATHS` so it bypasses the JWT gate. `GET` serves the
 * built-in page (no state change); `POST` performs the unsubscribe (the RFC 8058
 * one-click target, and what the page / an operator page call). Both
 * authenticate with the query `token` only.
 */
export function createPublicUnsubscribeRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(getUnsubscribeRoute, (c) => {
    // Deliberately does NOT unsubscribe — a pre-fetching link scanner must not be
    // able to opt someone out. The page's POST is the only mutation.
    return c.html(unsubscribePage(), 200);
  });

  app.openapi(postUnsubscribeRoute, async (c) => {
    const { newsletterId, subscriptionId, token } = c.req.valid('query');
    try {
      const subscription = await container
        .get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe)
        .execute(newsletterId, subscriptionId, token);
      return c.json({ status: 'unsubscribed', email: subscription?.email ?? null } as const, 200);
    } catch (err) {
      rethrow(err);
    }
  });

  return app;
}
