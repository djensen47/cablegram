import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  errorResponse,
  throwOnInvalid,
  type AppEnv,
} from '../../shared/http/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import {
  AccountsError,
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidOneTimeTokenError,
  InvalidRefreshTokenError,
  InvalidUserEmailError,
  SetupAlreadyCompletedError,
  UserNotFoundError,
} from '../domain/errors.js';
import type { RegisterInitialAdmin } from '../application/register-initial-admin.js';
import type { Login } from '../application/login.js';
import type { RefreshSession } from '../application/refresh-session.js';
import type { Logout } from '../application/logout.js';
import type { RequestPasswordReset } from '../application/request-password-reset.js';
import type { ResetPassword } from '../application/reset-password.js';
import type { RequestMagicLink } from '../application/request-magic-link.js';
import type { ConsumeMagicLink } from '../application/consume-magic-link.js';
import {
  AcceptedSchema,
  ConsumeMagicLinkSchema,
  LoginSchema,
  LogoutSchema,
  RefreshSchema,
  RequestMagicLinkSchema,
  RequestPasswordResetSchema,
  ResetPasswordSchema,
  SessionSchema,
  SetupSchema,
  UserSchema,
  toSessionResponse,
  toUserResponse,
} from './schemas.js';

const ACCEPTED = { status: 'accepted' } as const;

const conflictResponse = errorResponse('Conflict');
const badRequestResponse = errorResponse('Invalid request');
const unauthorizedResponse = errorResponse('Invalid credentials or token');

// Domain errors carry no HTTP status (ADR-001); translate them here, at the edge.
export function rethrowAccountsError(err: unknown): never {
  if (err instanceof SetupAlreadyCompletedError || err instanceof EmailAlreadyExistsError) {
    throw new ConflictError(err.message);
  }
  if (err instanceof InvalidCredentialsError || err instanceof InvalidRefreshTokenError) {
    throw new UnauthorizedError(err.message);
  }
  if (err instanceof UserNotFoundError) {
    throw new NotFoundError(err.message);
  }
  if (
    err instanceof InvalidUserEmailError ||
    err instanceof InvalidOneTimeTokenError ||
    err instanceof AccountsError
  ) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

const setupRoute = createRoute({
  method: 'post',
  path: '/setup',
  tags: ['auth'],
  summary: 'First-run setup: create the initial admin',
  description:
    'Open, one-time bootstrap (ADR-013): creates the first user as `admin`. Returns 409 once any user exists — thereafter user creation is admin-only via POST /v1/users.',
  request: {
    body: { content: { 'application/json': { schema: SetupSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The initial admin account',
    },
    400: badRequestResponse,
    409: conflictResponse,
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  tags: ['auth'],
  summary: 'Log in with email + password',
  description: 'Open. Returns a short-lived access JWT and an opaque refresh token.',
  request: {
    body: { content: { 'application/json': { schema: LoginSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SessionSchema } },
      description: 'A new session (access + refresh tokens)',
    },
    401: unauthorizedResponse,
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/auth/refresh',
  tags: ['auth'],
  summary: 'Exchange a refresh token for a new session',
  description:
    'Open. Rotates the refresh token: the presented token is consumed and a new access + refresh pair is returned.',
  request: {
    body: { content: { 'application/json': { schema: RefreshSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SessionSchema } },
      description: 'A new session (access + rotated refresh tokens)',
    },
    401: unauthorizedResponse,
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['auth'],
  summary: 'Revoke a refresh token',
  description: 'Open and idempotent: revokes the presented refresh token if it exists.',
  request: {
    body: { content: { 'application/json': { schema: LogoutSchema } }, required: true },
  },
  responses: {
    204: { description: 'The refresh token was revoked (or did not exist)' },
  },
});

const acceptedResponse = {
  200: {
    content: { 'application/json': { schema: AcceptedSchema } },
    description: 'Always returned, whether or not the address has an account',
  },
  400: badRequestResponse,
} as const;

const requestPasswordResetRoute = createRoute({
  method: 'post',
  path: '/auth/password-reset',
  tags: ['auth'],
  summary: 'Request a password-reset email',
  description:
    'Open and **non-enumerating** (ADR-013): always returns 200 whether or not the address has an ' +
    'account. If it does, an email with a single-use, expiring reset token is sent.',
  request: {
    body: { content: { 'application/json': { schema: RequestPasswordResetSchema } }, required: true },
  },
  responses: acceptedResponse,
});

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/password-reset/confirm',
  tags: ['auth'],
  summary: 'Complete a password reset',
  description:
    'Open. Consumes the emailed one-time token (single-use), sets the new password, and revokes all ' +
    'of the user’s existing sessions. An unknown/expired/used token is rejected (400).',
  request: {
    body: { content: { 'application/json': { schema: ResetPasswordSchema } }, required: true },
  },
  responses: {
    204: { description: 'The password was reset and existing sessions were revoked' },
    400: badRequestResponse,
  },
});

const requestMagicLinkRoute = createRoute({
  method: 'post',
  path: '/auth/magic-link',
  tags: ['auth'],
  summary: 'Request a magic-link login email',
  description:
    'Open and **non-enumerating** (ADR-014): always returns 200 whether or not the address has an ' +
    'account. If it does, an email with a single-use, expiring login token is sent.',
  request: {
    body: { content: { 'application/json': { schema: RequestMagicLinkSchema } }, required: true },
  },
  responses: acceptedResponse,
});

const consumeMagicLinkRoute = createRoute({
  method: 'post',
  path: '/auth/magic-link/consume',
  tags: ['auth'],
  summary: 'Exchange a magic-link token for a session',
  description:
    'Open (ADR-014). Consumes the emailed one-time token (single-use) and returns a normal session — ' +
    'identical in shape to a password login. An unknown/expired/used token is rejected (400).',
  request: {
    body: { content: { 'application/json': { schema: ConsumeMagicLinkSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SessionSchema } },
      description: 'A new session (access + refresh tokens)',
    },
    400: badRequestResponse,
  },
});

/**
 * The open authentication surface (ADR-013/014): first-run setup, the
 * login / refresh / logout exchange, and the password-reset + magic-link flows.
 * Mounted under `/v1` **without** `jwtAuth` — these are the endpoints a caller
 * reaches before (or to obtain) a token. Thin handlers: validate at the edge,
 * resolve a use case (ADR-003), map to a DTO.
 */
export function createAccountsAuthRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(setupRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const user = await container
        .get<RegisterInitialAdmin>(ACCOUNTS_TYPES.RegisterInitialAdmin)
        .execute(body);
      return c.json(toUserResponse(user), 201);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  app.openapi(loginRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const session = await container.get<Login>(ACCOUNTS_TYPES.Login).execute(body);
      return c.json(toSessionResponse(session), 200);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  app.openapi(refreshRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const session = await container
        .get<RefreshSession>(ACCOUNTS_TYPES.RefreshSession)
        .execute(body);
      return c.json(toSessionResponse(session), 200);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  app.openapi(logoutRoute, async (c) => {
    const body = c.req.valid('json');
    await container.get<Logout>(ACCOUNTS_TYPES.Logout).execute(body);
    return c.body(null, 204);
  });

  app.openapi(requestPasswordResetRoute, async (c) => {
    const body = c.req.valid('json');
    // Non-enumerating: succeed identically whether or not the account exists.
    await container.get<RequestPasswordReset>(ACCOUNTS_TYPES.RequestPasswordReset).execute(body);
    return c.json(ACCEPTED, 200);
  });

  app.openapi(resetPasswordRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      await container
        .get<ResetPassword>(ACCOUNTS_TYPES.ResetPassword)
        .execute({ token: body.token, newPassword: body.password });
      return c.body(null, 204);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  app.openapi(requestMagicLinkRoute, async (c) => {
    const body = c.req.valid('json');
    // Non-enumerating: succeed identically whether or not the account exists.
    await container.get<RequestMagicLink>(ACCOUNTS_TYPES.RequestMagicLink).execute(body);
    return c.json(ACCEPTED, 200);
  });

  app.openapi(consumeMagicLinkRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const session = await container
        .get<ConsumeMagicLink>(ACCOUNTS_TYPES.ConsumeMagicLink)
        .execute(body);
      return c.json(toSessionResponse(session), 200);
    } catch (err) {
      rethrowAccountsError(err);
    }
  });

  return app;
}
