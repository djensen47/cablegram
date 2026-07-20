import { OpenAPIHono, createRoute, type z } from '@hono/zod-openapi';
import type { Hook } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  BadRequestError,
  NotFoundError,
  paginationQuerySchema,
  toPage,
  type AppEnv,
} from '../../shared/http/index.js';
import { DELIVERABILITY_TYPES } from '../types.js';
import { DeliverabilityError, SuppressionNotFoundError } from '../domain/errors.js';
import type { AddSuppression } from '../application/add-suppression.js';
import type { ListSuppressions } from '../application/list-suppressions.js';
import type { RemoveSuppression } from '../application/remove-suppression.js';
import type { CheckSuppression } from '../application/check-suppression.js';
import {
  AddSuppressionSchema,
  ErrorSchema,
  SuppressionAddressParamSchema,
  SuppressionListSchema,
  SuppressionSchema,
  toSuppressionResponse,
} from './schemas.js';

const security = [{ ApiKeyAuth: [] }];

const notFoundResponse = {
  content: { 'application/json': { schema: ErrorSchema } },
  description: 'Suppression not found',
} as const;

const badRequestResponse = {
  content: { 'application/json': { schema: ErrorSchema } },
  description: 'Invalid request',
} as const;

// Route out validation failures through the shared error envelope: throwing the
// ZodError lets `onError` (shared/http) render `{ error: { code, ... } }` (ADR-004).
const throwOnInvalid: Hook<unknown, AppEnv, string, unknown> = (result) => {
  if (!result.success) {
    throw result.error as z.ZodError;
  }
};

// Domain errors carry no HTTP status (ADR-001); translate them here, at the edge.
function rethrowDomainError(err: unknown): never {
  if (err instanceof SuppressionNotFoundError) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof DeliverabilityError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['suppressions'],
  summary: 'List suppressed addresses',
  security,
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SuppressionListSchema } },
      description: 'A page of suppression entries',
    },
  },
});

const addRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['suppressions'],
  summary: 'Suppress an address',
  security,
  request: {
    body: { content: { 'application/json': { schema: AddSuppressionSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: SuppressionSchema } },
      description: 'The suppression entry (idempotent: existing entries are returned unchanged)',
    },
    400: badRequestResponse,
  },
});

const checkRoute = createRoute({
  method: 'get',
  path: '/{address}',
  tags: ['suppressions'],
  summary: 'Check whether an address is suppressed',
  security,
  request: { params: SuppressionAddressParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SuppressionSchema } },
      description: 'The suppression entry',
    },
    404: notFoundResponse,
  },
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/{address}',
  tags: ['suppressions'],
  summary: 'Remove an address from the suppression list',
  security,
  request: { params: SuppressionAddressParamSchema },
  responses: {
    204: { description: 'The suppression entry was removed' },
    404: notFoundResponse,
  },
});

/**
 * The deliverability HTTP surface (ADR-006). Thin handlers: validate at the
 * edge, resolve a use case from the container (ADR-003), map to a response
 * DTO. An `OpenAPIHono` so its routes flow into the generated spec when
 * mounted.
 */
export function createDeliverabilityRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(listRoute, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const rows = await container
      .get<ListSuppressions>(DELIVERABILITY_TYPES.ListSuppressions)
      .execute({ limit, cursor });
    const page = toPage(rows, limit, (e) => e.address);
    return c.json({ data: page.data.map(toSuppressionResponse), meta: page.meta }, 200);
  });

  app.openapi(addRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const entry = await container
        .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
        .execute(body);
      return c.json(toSuppressionResponse(entry), 201);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(checkRoute, async (c) => {
    const { address } = c.req.valid('param');
    const entry = await container
      .get<CheckSuppression>(DELIVERABILITY_TYPES.CheckSuppression)
      .execute(address);
    if (entry === null) {
      throw new NotFoundError(`Suppression not found: ${address}`);
    }
    return c.json(toSuppressionResponse(entry), 200);
  });

  app.openapi(removeRoute, async (c) => {
    const { address } = c.req.valid('param');
    try {
      await container
        .get<RemoveSuppression>(DELIVERABILITY_TYPES.RemoveSuppression)
        .execute(address);
      return c.body(null, 204);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
