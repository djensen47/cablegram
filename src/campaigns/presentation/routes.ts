import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Container } from 'inversify';
import {
  AppError,
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
  CampaignChannelMissingError,
  CampaignSendOutcomeUnknownError,
  CampaignSendRejectedError,
  CampaignSendUnresolvedError,
  CampaignStateError,
  SendNotFoundError,
} from '../domain/errors.js';
import type { CreateCampaign } from '../application/create-campaign.js';
import type { GetCampaign } from '../application/get-campaign.js';
import type { ListCampaigns } from '../application/list-campaigns.js';
import type { UpdateCampaign } from '../application/update-campaign.js';
import type { DeleteCampaign } from '../application/delete-campaign.js';
import type { SendCampaign } from '../application/send-campaign.js';
import type { ResolveSend } from '../application/resolve-send.js';
import type { SendTestCampaign } from '../application/send-test-campaign.js';
import type { GetSend } from '../application/get-send.js';
import type { ListRecipientOutcomes } from '../application/list-recipient-outcomes.js';
import {
  CampaignIdParamSchema,
  CampaignListSchema,
  CampaignSchema,
  CreateCampaignSchema,
  ListCampaignsQuerySchema,
  SendSchema,
  ResolveSendSchema,
  SendTestCampaignSchema,
  TestSendSchema,
  RecipientOutcomeListSchema,
  ListRecipientOutcomesQuerySchema,
  UpdateCampaignSchema,
  toCampaignResponse,
  toSendResponse,
  toTestSendResponse,
  toRecipientOutcomeResponse,
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

/**
 * What to do about a send left in `sending` (ADR-035). Appended wherever that
 * state is reported, so the response that says "stuck" also says how to get out.
 */
function howToResolve(campaignId: string): string {
  return (
    `Check the provider for messages tagged ${campaignId}, then record what happened: ` +
    `POST /v1/campaigns/${campaignId}/send/resolve with {"outcome": "sent"} or ` +
    `{"outcome": "not-sent"}.`
  );
}

// Domain errors carry no HTTP status (ADR-001); translate them here, at the edge.
function rethrowDomainError(err: unknown): never {
  if (
    err instanceof CampaignNotFoundError ||
    err instanceof CampaignNewsletterNotFoundError ||
    err instanceof SendNotFoundError
  ) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof CampaignStateError) {
    throw new ConflictError(err.message);
  }
  if (err instanceof CampaignChannelMissingError) {
    // A fact about the newsletter's setup, not this request: say how to fix it.
    throw new ConflictError(
      `${err.message}. Set it with PATCH /v1/newsletters/${err.newsletterId} ` +
        `({"campaignChannel": "<stream-id>"}), or ` +
        `"cablegram newsletters update ${err.newsletterId} --campaign-channel <stream-id>".`,
    );
  }
  // The three ways a send ends without going out cleanly (ADR-035). What the
  // caller needs from each is the same thing: may I send again?
  if (err instanceof CampaignSendRejectedError) {
    // Yes. The provider's own answer is in the message — it says what to fix.
    throw new AppError(
      `${err.message}. Nothing was sent; the campaign is "failed" and can be sent again once ` +
        `that is fixed.`,
      502,
      'send_rejected',
    );
  }
  if (err instanceof CampaignSendOutcomeUnknownError) {
    // No — and not "later" either. The provider may have it.
    throw new AppError(
      `${err.message}. The campaign is left in "sending" and will not be sent again. ` +
        howToResolve(err.campaignId),
      502,
      'send_outcome_unknown',
    );
  }
  if (err instanceof CampaignSendUnresolvedError) {
    // The same state, met by a later request: a conflict, with the same code.
    throw new AppError(
      `${err.message}. It may still be in progress. Another send was not started. ` +
        howToResolve(err.campaignId),
      409,
      'send_outcome_unknown',
    );
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
    'Resolves subscribed recipients, drops suppressed addresses, renders once and hands one ' +
    'broadcast to the provider. Safe to repeat: it never submits a campaign twice. Re-sending a ' +
    'sent campaign is a no-op; repeating a send the provider accepted but that was not fully ' +
    'recorded finishes the recording. A 502 `send_rejected` means the provider refused and ' +
    'nothing went out (the campaign is `failed` and can be sent again). A 502 or 409 ' +
    '`send_outcome_unknown` means a send was started and never confirmed; the campaign stays ' +
    '`sending` and is not sent again.',
  security,
  request: { params: CampaignIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: CampaignSchema } },
      description: 'The campaign after the send (status sent)',
    },
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
    502: errorResponse('The provider refused the send, or gave no definite answer'),
    ...authedResponses,
  },
});

const resolveSendRoute = createRoute({
  method: 'post',
  path: '/{id}/send/resolve',
  tags: ['campaigns'],
  summary: 'Record what happened to a send whose outcome is unknown',
  description:
    'For a campaign left in `sending`: a send was started and never confirmed, and cablegram ' +
    'will not start another. Look at the provider, then record the answer. `sent` completes the ' +
    'campaign. `not-sent` returns it to `failed`, from which it can be sent again — so it is ' +
    'refused (409) when cablegram holds evidence the send went out (a stored provider ' +
    'acknowledgment, or delivery events for it) and for 15 minutes after the send started, ' +
    'while its request may still be running.',
  security,
  request: {
    params: CampaignIdParamSchema,
    body: { content: { 'application/json': { schema: ResolveSendSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CampaignSchema } },
      description: 'The campaign after the answer was recorded (status sent or failed)',
    },
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
    ...authedResponses,
  },
});

const testSendRoute = createRoute({
  method: 'post',
  path: '/{id}/test',
  tags: ['campaigns'],
  summary: 'Send a campaign to a few named addresses, as a proof',
  description:
    'Renders through the exact same path as a real send (same renderer call, same List-Unsubscribe ' +
    'headers, same broadcast stream) and delivers only to the addresses given — the subscriber list ' +
    'is never read. Records nothing: no send, no recipient outcomes, no stats, no state change, so ' +
    'it is safe to repeat while iterating on a template. The global suppression list still applies. ' +
    'Legal in any status, including sent.',
  security,
  request: {
    params: CampaignIdParamSchema,
    body: { content: { 'application/json': { schema: SendTestCampaignSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: TestSendSchema } },
      description: 'What the test send delivered (and what it dropped as suppressed)',
    },
    400: badRequestResponse,
    404: notFoundResponse,
    ...authedResponses,
  },
});

const getSendRoute = createRoute({
  method: 'get',
  path: '/{id}/send',
  tags: ['campaigns'],
  summary: 'Get a campaign’s send (submission facts + live stats)',
  description:
    'Per-recipient outcomes are NOT inlined — at scale that is a multi-megabyte response. ' +
    'Read them from GET /campaigns/{id}/send/recipients, which is cursor-paginated.',
  security,
  request: { params: CampaignIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SendSchema } },
      description: 'The send, with stats counted live from its recipients',
    },
    404: notFoundResponse,
    ...authedResponses,
  },
});

const listRecipientsRoute = createRoute({
  method: 'get',
  path: '/{id}/send/recipients',
  tags: ['campaigns'],
  summary: 'List a send’s per-recipient outcomes (cursor-paginated)',
  description:
    'One row per recipient: delivery status, opens and clicks. Filter with `status`, or ' +
    '`failuresOnly=true` for bounced + complained in one query.',
  security,
  request: { params: CampaignIdParamSchema, query: ListRecipientOutcomesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: RecipientOutcomeListSchema } },
      description: 'A page of recipient outcomes',
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

  app.openapi(resolveSendRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { outcome } = c.req.valid('json');
    try {
      const campaign = await container
        .get<ResolveSend>(CAMPAIGN_TYPES.ResolveSend)
        .execute({ campaignId: id, outcome });
      return c.json(toCampaignResponse(campaign), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(testSendRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { to, prefixSubject } = c.req.valid('json');
    try {
      const result = await container
        .get<SendTestCampaign>(CAMPAIGN_TYPES.SendTestCampaign)
        .execute({ campaignId: id, addresses: to, prefixSubject });
      return c.json(toTestSendResponse(result), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(listRecipientsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { limit, cursor, status, failuresOnly } = c.req.valid('query');
    // `failuresOnly` is the common report question ("who didn't get it?") —
    // expressed as a status set so the store filters on its index.
    const statuses =
      failuresOnly === true
        ? (['bounced', 'complained'] as const)
        : status !== undefined
          ? ([status] as const)
          : undefined;
    try {
      const rows = await container
        .get<ListRecipientOutcomes>(CAMPAIGN_TYPES.ListRecipientOutcomes)
        .execute({ campaignId: id, statuses, limit, cursor });
      const page = toPage(rows, limit, (o) => o.id);
      return c.json({ data: page.data.map(toRecipientOutcomeResponse), meta: page.meta }, 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  app.openapi(getSendRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const { send, stats } = await container
        .get<GetSend>(CAMPAIGN_TYPES.GetSend)
        .execute(id);
      return c.json(toSendResponse(send, stats), 200);
    } catch (err) {
      rethrowDomainError(err);
    }
  });

  return app;
}
