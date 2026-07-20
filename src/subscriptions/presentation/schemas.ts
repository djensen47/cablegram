import { z } from '@hono/zod-openapi';
import { listResponseSchema, paginationQuerySchema } from '../../shared/http/index.js';
import { SUBSCRIPTION_STATUSES, type Subscription } from '../domain/subscription.js';

/**
 * zod-OpenAPI schemas for the subscriptions API. These are the single source of
 * truth for both edge validation (ADR-006) and the generated OpenAPI spec
 * (ADR-004) — the contract is the product. Named via `.openapi(name)` so they
 * surface as reusable `#/components/schemas` entries.
 */

const emailField = z.string().trim().email().max(320);
const statusField = z.enum(SUBSCRIPTION_STATUSES).openapi({ example: 'subscribed' });
const mergeFieldsField = z
  .record(z.unknown())
  .openapi({ type: 'object', example: { firstName: 'Ada' } });
const tagsField = z.array(z.string().trim().min(1).max(64)).openapi({ example: ['vip', 'beta'] });

export const SubscriptionSchema = z
  .object({
    id: z.string().openapi({ example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33' }),
    newsletterId: z.string().openapi({ example: '9f21-2b0e5d8a1c33-4a7f2c1e-6b1a' }),
    email: z.string().email().openapi({ example: 'reader@dispatch.example' }),
    status: statusField,
    mergeFields: z.record(z.unknown()).openapi({ type: 'object', example: { firstName: 'Ada' } }),
    tags: z.array(z.string()).openapi({ example: ['vip'] }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Subscription');

export const SubscribeSchema = z
  .object({
    email: emailField.openapi({ example: 'reader@dispatch.example' }),
    mergeFields: mergeFieldsField.optional(),
    tags: tagsField.optional(),
    doubleOptIn: z
      .boolean()
      .optional()
      .openapi({ description: 'Per-newsletter opt-in toggle; defaults to true (double opt-in).' }),
  })
  .openapi('Subscribe');

export const SubscriptionListSchema = listResponseSchema(SubscriptionSchema, 'SubscriptionList');

/** Query filters for the list route: pagination + query-time status/tag segment. */
export const ListSubscriptionsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
});

export const NewsletterIdParamSchema = z.object({
  newsletterId: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'newsletterId', in: 'path' },
      example: '9f21-2b0e5d8a1c33-4a7f2c1e-6b1a',
    }),
});

export const SubscriptionParamsSchema = z.object({
  newsletterId: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'newsletterId', in: 'path' },
      example: '9f21-2b0e5d8a1c33-4a7f2c1e-6b1a',
    }),
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33',
    }),
});

export type SubscriptionResponse = z.infer<typeof SubscriptionSchema>;

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toSubscriptionResponse(subscription: Subscription): SubscriptionResponse {
  return {
    id: subscription.id,
    newsletterId: subscription.newsletterId,
    email: subscription.email,
    status: subscription.status,
    mergeFields: subscription.mergeFields,
    tags: [...subscription.tags],
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}
