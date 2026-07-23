import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  errorResponse,
  paginationQuerySchema,
  requireRole,
  throwOnInvalid,
  toPage,
  type AppEnv,
} from '../../shared/http/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import type { CreateUser } from '../application/create-user.js';
import type { ListUsers } from '../application/list-users.js';
import type { GetUser } from '../application/get-user.js';
import { rethrowAccountsError } from './auth-routes.js';
import {
  CreateUserSchema,
  UserIdParamSchema,
  UserListSchema,
  UserSchema,
  toUserResponse,
} from './schemas.js';

// Admin-only surface (ADR-013). `jwtAuth` runs upstream (mounted by the app on
// the protected `/v1` router) and sets the caller; a JWT scheme documents that.
const security = [{ BearerAuth: [] }];

const notFoundResponse = errorResponse('User not found');
const badRequestResponse = errorResponse('Invalid request');
const conflictResponse = errorResponse('A user already exists with that email');
const forbiddenResponse = errorResponse('Requires the admin role');

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['users'],
  summary: 'List users',
  security,
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: UserListSchema } },
      description: 'A page of users',
    },
    403: forbiddenResponse,
  },
});

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['users'],
  summary: 'Create a user (admin only)',
  security,
  request: {
    body: { content: { 'application/json': { schema: CreateUserSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The created user',
    },
    400: badRequestResponse,
    403: forbiddenResponse,
    409: conflictResponse,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['users'],
  summary: 'Get a user',
  security,
  request: { params: UserIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The user',
    },
    403: forbiddenResponse,
    404: notFoundResponse,
  },
});

/**
 * The admin-only user-management surface (ADR-013). The router guards **every**
 * route with `requireRole('admin')` up front — `jwtAuth` (mounted by the app on
 * the protected `/v1` router) has already established the caller, so a manager
 * token reaches here and is rejected 403. Thin handlers: validate at the edge,
 * resolve a use case (ADR-003), map to a DTO.
 */
export function createUserRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.use('*', requireRole('admin'));

  app.openapi(listRoute, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const rows = await container.get<ListUsers>(ACCOUNTS_TYPES.ListUsers).execute({ limit, cursor });
    const page = toPage(rows, limit, (u) => u.id);
    return c.json({ data: page.data.map(toUserResponse), meta: page.meta }, 200);
  });

  app.openapi(createRoute_, async (c) => {
    const body = c.req.valid('json');
    try {
      const user = await container.get<CreateUser>(ACCOUNTS_TYPES.CreateUser).execute(body);
      return c.json(toUserResponse(user), 201);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const user = await container.get<GetUser>(ACCOUNTS_TYPES.GetUser).execute(id);
      return c.json(toUserResponse(user), 200);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  return app;
}
