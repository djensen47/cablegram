import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  BadRequestError,
  NotFoundError,
  errorResponse,
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
import {
  ListSubscriptionsQuerySchema,
  NewsletterIdParamSchema,
  SubscribeSchema,
  SubscriptionListSchema,
  SubscriptionParamsSchema,
  SubscriptionSchema,
  toSubscriptionResponse,
} from './schemas.js';

const security = [{ ApiKeyAuth: [] }];

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

const confirmRoute = createRoute({
  method: 'post',
  path: '/{newsletterId}/subscriptions/{id}/confirm',
  tags: ['subscriptions'],
  summary: 'Confirm a pending subscription (double opt-in)',
  security,
  request: { params: SubscriptionParamsSchema },
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
  request: { params: SubscriptionParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SubscriptionSchema } },
      description: 'The unsubscribed subscription',
    },
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
    const body = c.req.valid('json');
    try {
      const subscription = await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, ...body });
      return c.json(toSubscriptionResponse(subscription), 201);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(confirmRoute, async (c) => {
    const { newsletterId, id } = c.req.valid('param');
    try {
      const subscription = await container
        .get<ConfirmSubscription>(SUBSCRIPTION_TYPES.ConfirmSubscription)
        .execute(newsletterId, id);
      return c.json(toSubscriptionResponse(subscription), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(unsubscribeRoute, async (c) => {
    const { newsletterId, id } = c.req.valid('param');
    try {
      const subscription = await container
        .get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe)
        .execute(newsletterId, id);
      return c.json(toSubscriptionResponse(subscription), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
