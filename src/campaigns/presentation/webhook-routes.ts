import { timingSafeEqual } from 'node:crypto';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import type { Container } from 'inversify';
import { TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import {
  UnauthorizedError,
  errorResponse,
  throwOnInvalid,
  type AppEnv,
} from '../../shared/http/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { RecordDeliveryEvents } from '../application/record-delivery-events.js';
import { PostmarkWebhookSchema, WebhookAckSchema } from './schemas.js';

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * HTTP Basic-Auth verification for the Postmark webhook (ADR-008). Postmark
 * offers **no** signature/HMAC — only Basic Auth on the webhook URL — so the
 * receiver checks the Basic credential's password against the configured
 * `POSTMARK_WEBHOOK_SECRET` with a constant-time comparison. The username is
 * ignored (Postmark lets you set any). This is the whole reason the webhook is
 * mounted at the top level rather than behind the `/v1` API key.
 */
function verifyPostmarkWebhook(secret: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization');
    if (header === undefined || !header.toLowerCase().startsWith('basic ')) {
      throw new UnauthorizedError();
    }
    const decoded = Buffer.from(header.slice('basic '.length).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const password = sep === -1 ? decoded : decoded.slice(sep + 1);
    if (!safeEquals(password, secret)) {
      throw new UnauthorizedError();
    }
    await next();
  });
}

const webhookRoute = createRoute({
  method: 'post',
  path: '/webhooks/postmark',
  tags: ['webhooks'],
  summary: 'Receive a Postmark delivery event',
  description:
    'Basic-Auth protected (not the /v1 API key). Normalizes the event, records the outcome on the send record and suppresses hard bounces / spam complaints. Idempotent and always 200s on an authenticated request.',
  request: {
    body: { content: { 'application/json': { schema: PostmarkWebhookSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: WebhookAckSchema } },
      description: 'The event was accepted (and applied if it matched a campaign)',
    },
    401: errorResponse('Missing or invalid webhook credential'),
  },
});

/**
 * The Postmark webhook receiver (ADR-008), mounted at the **top level** of the
 * app — not under `/v1` — with its own Basic-Auth verification. It normalizes
 * the provider event (`email.parseProviderEvent`), records outcomes on the send
 * record and pushes hard-bounce / spam-complaint addresses to the suppression
 * list, tolerating duplicate/out-of-order delivery (idempotent).
 */
export function createPostmarkWebhookRoutes(container: Container): OpenAPIHono<AppEnv> {
  const config = container.get<AppConfig>(TYPES.Config);
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.use('/webhooks/postmark', verifyPostmarkWebhook(config.postmark.webhookSecret));

  app.openapi(webhookRoute, async (c) => {
    const body = c.req.valid('json');
    await container
      .get<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents)
      .execute(body);
    return c.json({ status: 'ok' }, 200);
  });

  return app;
}
