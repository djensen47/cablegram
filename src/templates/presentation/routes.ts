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
import { TEMPLATE_TYPES } from '../types.js';
import { TemplateError, TemplateNotFoundError } from '../domain/errors.js';
import type { CreateTemplate } from '../application/create-template.js';
import type { GetTemplate } from '../application/get-template.js';
import type { ListTemplates } from '../application/list-templates.js';
import type { UpdateTemplate } from '../application/update-template.js';
import type { DeleteTemplate } from '../application/delete-template.js';
import {
  CreateTemplateSchema,
  TemplateIdParamSchema,
  TemplateListSchema,
  TemplateSchema,
  UpdateTemplateSchema,
  toTemplateResponse,
} from './schemas.js';

const security = [{ ApiKeyAuth: [] }];

const notFoundResponse = errorResponse('Template not found');
const badRequestResponse = errorResponse('Invalid request');

// Domain errors carry no HTTP status (ADR-001); translate them here, at the
// edge. `TemplateNotFoundError` first (it's a `TemplateError` subclass too),
// so it maps to 404 instead of falling into the generic 400 branch.
function rethrowDomainError(err: unknown): never {
  if (err instanceof TemplateNotFoundError) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof TemplateError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['templates'],
  summary: 'List templates',
  security,
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: TemplateListSchema } },
      description: 'A page of templates',
    },
  },
});

const createTemplateRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['templates'],
  summary: 'Create a template',
  security,
  request: {
    body: { content: { 'application/json': { schema: CreateTemplateSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: TemplateSchema } },
      description: 'The created template',
    },
    400: badRequestResponse,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['templates'],
  summary: 'Get a template',
  security,
  request: { params: TemplateIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: TemplateSchema } },
      description: 'The template',
    },
    404: notFoundResponse,
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['templates'],
  summary: 'Update a template',
  security,
  request: {
    params: TemplateIdParamSchema,
    body: { content: { 'application/json': { schema: UpdateTemplateSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: TemplateSchema } },
      description: 'The updated template',
    },
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['templates'],
  summary: 'Delete a template',
  security,
  request: { params: TemplateIdParamSchema },
  responses: {
    204: { description: 'The template was deleted' },
    404: notFoundResponse,
  },
});

/**
 * The templates HTTP surface (ADR-006). Thin handlers: validate at the edge,
 * resolve a use case from the container (ADR-003), map to a response DTO. An
 * `OpenAPIHono` so its routes flow into the generated spec when mounted.
 */
export function createTemplateRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(listRoute, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const rows = await container
      .get<ListTemplates>(TEMPLATE_TYPES.ListTemplates)
      .execute({ limit, cursor });
    const page = toPage(rows, limit, (t) => t.id);
    return c.json({ data: page.data.map(toTemplateResponse), meta: page.meta }, 200);
  });

  app.openapi(createTemplateRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const template = await container
        .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
        .execute(body);
      return c.json(toTemplateResponse(template), 201);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const template = await container.get<GetTemplate>(TEMPLATE_TYPES.GetTemplate).execute(id);
      return c.json(toTemplateResponse(template), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const template = await container
        .get<UpdateTemplate>(TEMPLATE_TYPES.UpdateTemplate)
        .execute(id, body);
      return c.json(toTemplateResponse(template), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await container.get<DeleteTemplate>(TEMPLATE_TYPES.DeleteTemplate).execute(id);
      return c.body(null, 204);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
