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
// An opaque operator note, bounded so it stays a label rather than a payload.
const sourceField = z.string().trim().min(1).max(200);

export const SubscriptionSchema = z
  .object({
    id: z.string().openapi({ example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33' }),
    newsletterId: z.string().openapi({ example: '9f21-2b0e5d8a1c33-4a7f2c1e-6b1a' }),
    email: z.string().email().openapi({ example: 'reader@dispatch.example' }),
    status: statusField,
    mergeFields: z.record(z.unknown()).openapi({ type: 'object', example: { firstName: 'Ada' } }),
    tags: z.array(z.string()).openapi({ example: ['vip'] }),
    source: z
      .string()
      .nullable()
      .openapi({
        description:
          'Where this record came from when it did not originate here (ADR-022). `null` means ' +
          'cablegram collected the consent itself — the subscribe/confirm path.',
        example: 'mailchimp-export-2026-07',
      }),
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

/**
 * The largest batch one import request may carry (ADR-022). Sized so a whole
 * batch is comfortably one Mongo bulk write and one function invocation, and so
 * an 18k-row migration is tens of requests rather than tens of thousands.
 */
export const IMPORT_BATCH_LIMIT = 1000;

const ImportRowSchema = z
  .object({
    email: emailField.openapi({ example: 'reader@dispatch.example' }),
    status: statusField
      .optional()
      .openapi({ description: 'Restored verbatim. Absent → the batch’s `defaultStatus`.' }),
    mergeFields: mergeFieldsField.optional(),
    tags: tagsField.optional(),
    subscribedAt: z
      .string()
      .datetime()
      .optional()
      .openapi({
        description:
          'The original opt-in date from the source system; stored as `createdAt`, because that ' +
          'timestamp is the consent record. Absent → now.',
        example: '2019-04-02T09:15:00.000Z',
      }),
    source: sourceField
      .optional()
      .openapi({ description: 'Per-row provenance override. Absent → the batch’s `source`.' }),
  })
  .openapi('ImportSubscriptionRow');

export const ImportSubscriptionsSchema = z
  .object({
    rows: z.array(ImportRowSchema).min(1).max(IMPORT_BATCH_LIMIT),
    onConflict: z
      .enum(['skip', 'overwrite'])
      .optional()
      .openapi({
        description:
          'What to do when the address already has a membership. `skip` (the default) leaves the ' +
          'stored row untouched, so a re-run is a cheap resume; `overwrite` makes the file the ' +
          'source of truth for every field, opt-outs included. There is no partial/merge mode.',
        example: 'skip',
      }),
    defaultStatus: statusField
      .optional()
      .openapi({ description: 'Status for rows carrying none. Defaults to `subscribed`.' }),
    source: sourceField.optional().openapi({
      description:
        'Where this batch came from, recorded on every row it writes so an inherited consent ' +
        'claim stays distinguishable from one cablegram witnessed. Defaults to `import` — a row ' +
        'written by this endpoint is always marked as imported, named source or not.',
      example: 'mailchimp-export-2026-07',
    }),
  })
  .openapi('ImportSubscriptions');

export const ImportResultSchema = z
  .object({
    received: z.number().int().openapi({ example: 500 }),
    created: z.number().int().openapi({ example: 480 }),
    updated: z.number().int().openapi({ example: 0 }),
    skipped: z.number().int().openapi({ example: 20 }),
    suppressed: z
      .number()
      .int()
      .openapi({
        description:
          'Imported hard bounces added to the GLOBAL suppression list (ADR-018/ADR-022). Driven ' +
          'by the file, not by `onConflict`: a skipped row’s mailbox is no less dead.',
        example: 12,
      }),
    byStatus: z
      .record(z.number().int())
      .openapi({ type: 'object', example: { subscribed: 460, unsubscribed: 20 } }),
  })
  .openapi('ImportResult');

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
    source: subscription.source ?? null,
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}
