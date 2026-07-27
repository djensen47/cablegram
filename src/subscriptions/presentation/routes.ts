import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  BadRequestError,
  NotFoundError,
  errorResponse,
  optionalJsonBody,
  throwOnInvalid,
  toPage,
  type AppEnv,
} from '../../shared/http/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import {
  SubscriptionError,
  SubscriptionNewsletterNotFoundError,
  SubscriptionNotFoundError,
} from '../domain/errors.js';
import type { Subscribe } from '../application/subscribe.js';
import type { ConfirmSubscription } from '../application/confirm-subscription.js';
import type { Unsubscribe } from '../application/unsubscribe.js';
import type { ListSubscriptions } from '../application/list-subscriptions.js';
import type { ImportSubscriptions } from '../application/import-subscriptions.js';
import {
  ConsentActionSchema,
  ImportResultSchema,
  ImportSubscriptionsSchema,
  ListSubscriptionsQuerySchema,
  NewsletterIdParamSchema,
  SubscribeSchema,
  SubscriptionListSchema,
  SubscriptionParamsSchema,
  SubscriptionSchema,
  toSubscriptionResponse,
} from './schemas.js';

const security = [{ BearerAuth: [] }];

const notFoundResponse = errorResponse('Newsletter or subscription not found');
const badRequestResponse = errorResponse('Invalid request');

// Domain errors carry no HTTP status (ADR-001); translate them here, at the edge.
function rethrowDomainError(err: unknown): never {
  if (
    err instanceof SubscriptionNotFoundError ||
    err instanceof SubscriptionNewsletterNotFoundError
  ) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof SubscriptionError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

const listRoute = createRoute({
  method: 'get',
  path: '/{newsletterId}/subscriptions',
  tags: ['subscriptions'],
  summary: 'List a newsletter’s subscriptions',
  security,
  request: { params: NewsletterIdParamSchema, query: ListSubscriptionsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SubscriptionListSchema } },
      description: 'A page of subscriptions',
    },
  },
});

const subscribeRoute = createRoute({
  method: 'post',
  path: '/{newsletterId}/subscriptions',
  tags: ['subscriptions'],
  summary: 'Subscribe an address to a newsletter',
  security,
  request: {
    params: NewsletterIdParamSchema,
    body: { content: { 'application/json': { schema: SubscribeSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: SubscriptionSchema } },
      description:
        'The subscription (pending under double opt-in; existing memberships are returned unchanged)',
    },
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

const importRoute = createRoute({
  method: 'post',
  path: '/{newsletterId}/subscriptions/import',
  tags: ['subscriptions'],
  summary: 'Import a batch of memberships from another provider',
  description:
    'Restores existing memberships — **not** a bulk subscribe (ADR-022). Each row’s `status` is ' +
    'taken verbatim across the full lifecycle vocabulary, so a migrated list keeps the people who ' +
    'unsubscribed, bounced or complained instead of silently re-subscribing them. **No email is ' +
    'sent by this endpoint**, not even for `pending` rows: an import restores consent that already ' +
    'exists rather than seeking new consent.\n\n' +
    'An imported `bounced` row is also added to the global suppression list — a dead mailbox is a ' +
    'fact about the address, true for every newsletter (ADR-018). An imported `complained` row is ' +
    'never added to it.\n\n' +
    'Send batches of up to 1000 rows. Honours `Idempotency-Key`, so a retried batch whose response ' +
    'was lost replays instead of re-running.',
  security,
  request: {
    params: NewsletterIdParamSchema,
    body: {
      content: { 'application/json': { schema: ImportSubscriptionsSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ImportResultSchema } },
      description: 'What the batch did: created/updated/skipped counts and the status breakdown',
    },
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

const confirmRoute = createRoute({
  method: 'post',
  path: '/{newsletterId}/subscriptions/{id}/confirm',
  tags: ['subscriptions'],
  summary: 'Confirm a pending subscription (double opt-in)',
  description:
    'Records `confirmedAt` — the consent act itself, kept separately from `updatedAt` so a later ' +
    'bounce cannot erase when consent was given (ADR-023). Optionally send the subscriber’s `ip` ' +
    'and `userAgent`; cablegram cannot observe them, since the caller here is your backend.',
  security,
  request: {
    params: SubscriptionParamsSchema,
    body: { content: { 'application/json': { schema: ConsentActionSchema } }, required: false },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SubscriptionSchema } },
      description: 'The confirmed subscription',
    },
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

const unsubscribeRoute = createRoute({
  method: 'post',
  path: '/{newsletterId}/subscriptions/{id}/unsubscribe',
  tags: ['subscriptions'],
  summary: 'Unsubscribe a subscription',
  security,
  request: {
    params: SubscriptionParamsSchema,
    body: { content: { 'application/json': { schema: ConsentActionSchema } }, required: false },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SubscriptionSchema } },
      description: 'The unsubscribed subscription',
    },
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

/**
 * The subscriptions HTTP surface (ADR-006), nested under a newsletter
 * (`/v1/newsletters/{newsletterId}/subscriptions`). Thin handlers: validate at
 * the edge, resolve a use case from the container (ADR-003), map to a response
 * DTO. An `OpenAPIHono` so its routes flow into the generated spec when mounted.
 */
export function createSubscriptionRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  // Confirm and unsubscribe gained an optional evidence body (ADR-023) but are
  // called with none today; without this a bodyless POST that still sets a JSON
  // content-type would 500 in Hono's validator.
  app.use('/:newsletterId/subscriptions/:id/confirm', optionalJsonBody);
  app.use('/:newsletterId/subscriptions/:id/unsubscribe', optionalJsonBody);

  app.openapi(listRoute, async (c) => {
    const { newsletterId } = c.req.valid('param');
    const { limit, cursor, status, tag } = c.req.valid('query');
    const rows = await container
      .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
      .execute({ newsletterId, status, tag, limit, cursor });
    const page = toPage(rows, limit, (s) => s.id);
    return c.json({ data: page.data.map(toSubscriptionResponse), meta: page.meta }, 200);
  });

  app.openapi(subscribeRoute, async (c) => {
    const { newsletterId } = c.req.valid('param');
    const { signupIp, signupUserAgent, ...body } = c.req.valid('json');
    try {
      const subscription = await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({
          newsletterId,
          ...body,
          evidence: { ip: signupIp, userAgent: signupUserAgent },
        });
      return c.json(toSubscriptionResponse(subscription), 201);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(importRoute, async (c) => {
    const { newsletterId } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await container
        .get<ImportSubscriptions>(SUBSCRIPTION_TYPES.ImportSubscriptions)
        .execute({
          newsletterId,
          onConflict: body.onConflict,
          defaultStatus: body.defaultStatus,
          source: body.source,
          // The wire carries an ISO string; the use case takes a `Date` —
          // parsing belongs at the edge, like every other input conversion.
          rows: body.rows.map(({ subscribedAt, confirmedAt, unsubscribedAt, ...row }) => ({
            ...row,
            subscribedAt: subscribedAt === undefined ? undefined : new Date(subscribedAt),
            // The restored consent trail travels as its own object so the use
            // case hands it to the aggregate whole (ADR-023).
            consent: {
              signupIp: row.signupIp,
              signupUserAgent: row.signupUserAgent,
              confirmedAt: confirmedAt === undefined ? undefined : new Date(confirmedAt),
              confirmedIp: row.confirmedIp,
              confirmedUserAgent: row.confirmedUserAgent,
              unsubscribedAt: unsubscribedAt === undefined ? undefined : new Date(unsubscribedAt),
              unsubscribedIp: row.unsubscribedIp,
              unsubscribedUserAgent: row.unsubscribedUserAgent,
            },
          })),
        });
      return c.json(result, 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(confirmRoute, async (c) => {
    const { newsletterId, id } = c.req.valid('param');
    const evidence = c.req.valid('json');
    try {
      const subscription = await container
        .get<ConfirmSubscription>(SUBSCRIPTION_TYPES.ConfirmSubscription)
        .execute(newsletterId, id, evidence);
      return c.json(toSubscriptionResponse(subscription), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(unsubscribeRoute, async (c) => {
    const { newsletterId, id } = c.req.valid('param');
    const evidence = c.req.valid('json');
    try {
      const subscription = await container
        .get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe)
        .execute(newsletterId, id, evidence);
      return c.json(toSubscriptionResponse(subscription), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
