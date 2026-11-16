import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { Container } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import { CaptchaUnavailableError } from '../../shared/captcha/index.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  errorResponse,
  requestEvidence,
  throwOnInvalid,
  type AppEnv,
} from '../../shared/http/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import {
  InvalidCaptchaError,
  PublicSignupUnavailableError,
  SubscriptionConfirmationChannelMissingError,
  SubscriptionError,
  SubscriptionNewsletterNotFoundError,
} from '../domain/errors.js';
import type { PublicSubscribe } from '../application/public-subscribe.js';

/**
 * The fixed, public signup path (ADR-034). A fixed path, not
 * `/v1/newsletters/{id}/…`, because `OPEN_V1_PATHS` is an exact-match set —
 * the same reason `/v1/unsubscribe` is fixed (ADR-015).
 */
export const PUBLIC_SUBSCRIBE_PATH = '/v1/subscribe';

/** At most this many custom fields from a public form. */
export const PUBLIC_MAX_CUSTOM_FIELDS = 10;

/**
 * Names a public caller may not use as custom fields: the record's own
 * metadata (ADR-022/023/024). Custom fields can render into mail; provenance
 * and consent evidence must never be writable — or renderable — from outside.
 */
const RESERVED_FIELD_NAMES = new Set(
  [
    'email',
    'tags',
    'status',
    'subscribedAt',
    'source',
    'signupIp',
    'signupUserAgent',
    'confirmedAt',
    'confirmedIp',
    'confirmedUserAgent',
    'unsubscribedAt',
    'unsubscribedIp',
    'unsubscribedUserAgent',
  ].map((n) => n.toLowerCase()),
);

/**
 * Tighter than the operator API's custom fields: anyone can call this route,
 * so the shape is closed — short identifier keys, short string values, a
 * handful of them, no reserved names.
 */
const PublicCustomFieldsSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'must be a short identifier'),
    z.string().trim().max(200),
  )
  .refine((fields) => Object.keys(fields).length <= PUBLIC_MAX_CUSTOM_FIELDS, {
    message: `at most ${PUBLIC_MAX_CUSTOM_FIELDS} fields`,
  })
  .refine((fields) => Object.keys(fields).every((k) => !RESERVED_FIELD_NAMES.has(k.toLowerCase())), {
    message: 'uses a reserved field name',
  });

const PublicSubscribeSchema = z
  .object({
    newsletterId: z.string().min(1).openapi({ example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33' }),
    email: z.string().trim().email().max(320).openapi({ example: 'reader@example.com' }),
    customFields: PublicCustomFieldsSchema.optional().openapi({
      description: `Up to ${PUBLIC_MAX_CUSTOM_FIELDS} string fields (e.g. city, state). Reserved record names are refused.`,
      example: { city: 'Seattle', state: 'WA' },
    }),
    captchaToken: z.string().min(1).max(2048).openapi({
      description:
        'The Cloudflare Turnstile token from the widget on your form (`cf-turnstile-response`). ' +
        'Single-use, valid for five minutes.',
    }),
  })
  .openapi('PublicSubscribe');

const postRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['subscriptions'],
  summary: 'Public signup from a browser form (captcha-protected, no login)',
  description:
    'Open (ADR-034): no JWT; a Cloudflare Turnstile token authenticates that a human submitted it. ' +
    'The newsletter must have `publicSignup` on. Opt-in follows the newsletter (ADR-032). The answer ' +
    'is the same whether the address was new, already subscribed, or had left, so it reveals nothing ' +
    'about the list. A public single opt-in signup never re-subscribes an address that left. ' +
    'Cross-origin calls are allowed from `CORS_ALLOWED_ORIGINS`.',
  request: {
    body: { content: { 'application/json': { schema: PublicSubscribeSchema } }, required: true },
  },
  responses: {
    202: {
      content: {
        'application/json': { schema: z.object({ status: z.literal('accepted') }) },
      },
      description: 'Accepted',
    },
    400: errorResponse('Invalid input, or the captcha was rejected (`captcha_failed`)'),
    404: errorResponse('No newsletter open to public signup with that id'),
    409: errorResponse('The newsletter is double opt-in but has no confirmation channel'),
    503: errorResponse('Public signup is not configured, or the captcha provider is unreachable'),
  },
});

/** Domain errors carry no HTTP status (ADR-001); translate at the edge. */
function rethrow(err: unknown): never {
  if (err instanceof InvalidCaptchaError) {
    // A distinct code so a form can tell "try the captcha again" from bad input.
    throw new AppError(err.message, 400, 'captcha_failed');
  }
  if (err instanceof PublicSignupUnavailableError || err instanceof CaptchaUnavailableError) {
    throw new ServiceUnavailableError(err.message);
  }
  if (err instanceof SubscriptionNewsletterNotFoundError) {
    throw new NotFoundError('Newsletter not found');
  }
  if (err instanceof SubscriptionConfirmationChannelMissingError) {
    throw new ConflictError(err.message);
  }
  if (err instanceof SubscriptionError) {
    throw new BadRequestError(err.message);
  }
  throw err;
}

/**
 * The public signup surface (ADR-034), mounted at `/v1/subscribe` and listed in
 * `OPEN_V1_PATHS`. When `CORS_ALLOWED_ORIGINS` is set, browsers on those
 * origins may call it cross-origin (preflight included); otherwise only
 * same-origin pages can.
 */
export function createPublicSubscribeRoutes(container: Container): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: throwOnInvalid });

  const { corsAllowedOrigins } = container.get<AppConfig>(SHARED_TYPES.Config).publicSignup;
  if (corsAllowedOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: [...corsAllowedOrigins],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: 600,
      }),
    );
  }

  app.openapi(postRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      await container.get<PublicSubscribe>(SUBSCRIPTION_TYPES.PublicSubscribe).execute({
        newsletterId: body.newsletterId,
        email: body.email,
        customFields: body.customFields,
        captchaToken: body.captchaToken,
        // The one place, with `/v1/unsubscribe`, where the caller is the
        // subscriber, so reading the request is real evidence (ADR-023).
        evidence: requestEvidence(c),
      });
    } catch (err) {
      rethrow(err);
    }
    return c.json({ status: 'accepted' } as const, 202);
  });

  return app;
}
