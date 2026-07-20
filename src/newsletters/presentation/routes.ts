import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  BadRequestError,
  NotFoundError,
  errorResponse,
  paginationQuerySchema,
  throwOnInvalid,
  toPage,
  type AppEnv,
} from '../../shared/http/index.js';
import { NEWSLETTER_TYPES } from '../types.js';
import { NewsletterError, NewsletterNotFoundError } from '../domain/errors.js';
import type { CreateNewsletter } from '../application/create-newsletter.js';
import type { GetNewsletter } from '../application/get-newsletter.js';
import type { ListNewsletters } from '../application/list-newsletters.js';
import type { UpdateNewsletter } from '../application/update-newsletter.js';
import type { DeleteNewsletter } from '../application/delete-newsletter.js';
import {
  CreateNewsletterSchema,
  NewsletterIdParamSchema,
  NewsletterListSchema,
  NewsletterSchema,
  UpdateNewsletterSchema,
  toNewsletterResponse,
} from './schemas.js';

const security = [{ ApiKeyAuth: [] }];

const notFoundResponse = errorResponse('Newsletter not found');
const badRequestResponse = errorResponse('Invalid request');

// Domain errors carry no HTTP status (ADR-001); translate them here, at the edge.
function rethrowDomainError(err: unknown): never {
  if (err instanceof NewsletterNotFoundError) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof NewsletterError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['newsletters'],
  summary: 'List newsletters',
  security,
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: NewsletterListSchema } },
      description: 'A page of newsletters',
    },
  },
});

const createNewsletterRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['newsletters'],
  summary: 'Create a newsletter',
  security,
  request: {
    body: { content: { 'application/json': { schema: CreateNewsletterSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: NewsletterSchema } },
      description: 'The created newsletter',
    },
    400: badRequestResponse,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['newsletters'],
  summary: 'Get a newsletter',
  security,
  request: { params: NewsletterIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: NewsletterSchema } },
      description: 'The newsletter',
    },
    404: notFoundResponse,
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['newsletters'],
  summary: 'Update a newsletter',
  security,
  request: {
    params: NewsletterIdParamSchema,
    body: { content: { 'application/json': { schema: UpdateNewsletterSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: NewsletterSchema } },
      description: 'The updated newsletter',
    },
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['newsletters'],
  summary: 'Delete a newsletter',
  security,
  request: { params: NewsletterIdParamSchema },
  responses: {
    204: { description: 'The newsletter was deleted' },
    404: notFoundResponse,
  },
});

/**
 * The newsletters HTTP surface (ADR-006). Thin handlers: validate at the edge,
 * resolve a use case from the container (ADR-003), map to a response DTO. An
 * `OpenAPIHono` so its routes flow into the generated spec when mounted.
 */
export function createNewsletterRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(listRoute, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const rows = await container
      .get<ListNewsletters>(NEWSLETTER_TYPES.ListNewsletters)
      .execute({ limit, cursor });
    const page = toPage(rows, limit, (n) => n.id);
    return c.json({ data: page.data.map(toNewsletterResponse), meta: page.meta }, 200);
  });

  app.openapi(createNewsletterRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const newsletter = await container
        .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
        .execute(body);
      return c.json(toNewsletterResponse(newsletter), 201);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const newsletter = await container
        .get<GetNewsletter>(NEWSLETTER_TYPES.GetNewsletter)
        .execute(id);
      return c.json(toNewsletterResponse(newsletter), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const newsletter = await container
        .get<UpdateNewsletter>(NEWSLETTER_TYPES.UpdateNewsletter)
        .execute(id, body);
      return c.json(toNewsletterResponse(newsletter), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await container.get<DeleteNewsletter>(NEWSLETTER_TYPES.DeleteNewsletter).execute(id);
      return c.body(null, 204);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
