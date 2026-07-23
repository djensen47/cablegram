import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  errorResponse,
  throwOnInvalid,
  toPage,
  type AppEnv,
} from '../../shared/http/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import {
  CampaignError,
  CampaignNewsletterNotFoundError,
  CampaignNotFoundError,
  CampaignStateError,
  SendRecordNotFoundError,
} from '../domain/errors.js';
import type { CreateCampaign } from '../application/create-campaign.js';
import type { GetCampaign } from '../application/get-campaign.js';
import type { ListCampaigns } from '../application/list-campaigns.js';
import type { UpdateCampaign } from '../application/update-campaign.js';
import type { DeleteCampaign } from '../application/delete-campaign.js';
import type { SendCampaign } from '../application/send-campaign.js';
import type { GetSendRecord } from '../application/get-send-record.js';
import {
  CampaignIdParamSchema,
  CampaignListSchema,
  CampaignSchema,
  CreateCampaignSchema,
  ListCampaignsQuerySchema,
  SendRecordSchema,
  UpdateCampaignSchema,
  toCampaignResponse,
  toSendRecordResponse,
} from './schemas.js';

const security = [{ BearerAuth: [] }];

const notFoundResponse = errorResponse('Campaign or newsletter not found');
const badRequestResponse = errorResponse('Invalid request');
const conflictResponse = errorResponse(
  'The campaign is not in a state that permits this operation',
);
const unauthorizedResponse = errorResponse('Missing or invalid access token');

// Every route on this router sits behind `jwtAuth` (mounted at `/v1` in
// app.ts) — document the 401 it can produce on all of them (OpenAPI polish:
// the security requirement above only *declares* the scheme, it doesn't
// document the failure response).
const authedResponses = { 401: unauthorizedResponse } as const;

// Domain errors carry no HTTP status (ADR-001); translate them here, at the edge.
function rethrowDomainError(err: unknown): never {
  if (
    err instanceof CampaignNotFoundError ||
    err instanceof CampaignNewsletterNotFoundError ||
    err instanceof SendRecordNotFoundError
  ) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof CampaignStateError) {
    throw new ConflictError(err.message);
  }
  if (err instanceof CampaignError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['campaigns'],
  summary: 'List campaigns',
  security,
  request: { query: ListCampaignsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: CampaignListSchema } },
      description: 'A page of campaigns',
    },
    ...authedResponses,
  },
});

const createCampaignRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['campaigns'],
  summary: 'Create a campaign',
  security,
  request: {
    body: { content: { 'application/json': { schema: CreateCampaignSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CampaignSchema } },
      description: 'The created campaign (status draft)',
    },
    400: badRequestResponse,
    404: notFoundResponse,
    ...authedResponses,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Get a campaign',
  security,
  request: { params: CampaignIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: CampaignSchema } },
      description: 'The campaign',
    },
    404: notFoundResponse,
    ...authedResponses,
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Update a not-yet-sent campaign',
  security,
  request: {
    params: CampaignIdParamSchema,
    body: { content: { 'application/json': { schema: UpdateCampaignSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CampaignSchema } },
      description: 'The updated campaign',
    },
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
    ...authedResponses,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Delete a campaign',
  security,
  request: { params: CampaignIdParamSchema },
  responses: {
    204: { description: 'The campaign was deleted' },
    404: notFoundResponse,
    ...authedResponses,
  },
});

const sendRoute = createRoute({
  method: 'post',
  path: '/{id}/send',
  tags: ['campaigns'],
  summary: 'Send a campaign now',
  description:
    'Resolves subscribed recipients, drops suppressed addresses, renders once and hands one broadcast to the provider. Re-sending a sent campaign is a no-op.',
  security,
  request: { params: CampaignIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: CampaignSchema } },
      description: 'The campaign after the send (status sent, with aggregate stats)',
    },
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
    ...authedResponses,
  },
});

const getSendRoute = createRoute({
  method: 'get',
  path: '/{id}/send',
  tags: ['campaigns'],
  summary: 'Get a campaign’s send record (per-recipient outcomes)',
  security,
  request: { params: CampaignIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SendRecordSchema } },
      description: 'The send record',
    },
    404: notFoundResponse,
    ...authedResponses,
  },
});

/**
 * The campaigns HTTP surface (ADR-006), mounted at `/v1/campaigns`. Thin
 * handlers: validate at the edge, resolve a use case from the container
 * (ADR-003), map to a response DTO. An `OpenAPIHono` so its routes flow into the
 * generated spec when mounted. The Postmark webhook receiver is a separate
 * top-level router (`webhook-routes.ts`), not part of this API-key surface.
 */
export function createCampaignRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  app.openapi(listRoute, async (c) => {
    const { limit, cursor, newsletterId, status } = c.req.valid('query');
    const rows = await container
      .get<ListCampaigns>(CAMPAIGN_TYPES.ListCampaigns)
      .execute({ newsletterId, status, limit, cursor });
    const page = toPage(rows, limit, (campaign) => campaign.id);
    return c.json({ data: page.data.map(toCampaignResponse), meta: page.meta }, 200);
  });

  app.openapi(createCampaignRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      const campaign = await container
        .get<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign)
        .execute(body);
      return c.json(toCampaignResponse(campaign), 201);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const campaign = await container.get<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).execute(id);
      return c.json(toCampaignResponse(campaign), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const campaign = await container
        .get<UpdateCampaign>(CAMPAIGN_TYPES.UpdateCampaign)
        .execute(id, body);
      return c.json(toCampaignResponse(campaign), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await container.get<DeleteCampaign>(CAMPAIGN_TYPES.DeleteCampaign).execute(id);
      return c.body(null, 204);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(sendRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const campaign = await container.get<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).execute(id);
      return c.json(toCampaignResponse(campaign), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(getSendRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const record = await container.get<GetSendRecord>(CAMPAIGN_TYPES.GetSendRecord).execute(id);
      return c.json(toSendRecordResponse(record), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
