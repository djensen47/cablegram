import { z } from '@hono/zod-openapi';
import { listResponseSchema, paginationQuerySchema } from '../../shared/http/index.js';
import { CAMPAIGN_STATUSES, type Campaign, type CampaignStats } from '../domain/campaign.js';
import type { Send } from '../domain/send.js';
import { OUTCOME_STATUSES, type RecipientOutcome } from '../domain/recipient-outcome.js';
import type { UnhandledEventRecord } from '../application/unhandled-event-repository.js';

/**
 * zod-OpenAPI schemas for the campaigns API. These are the single source of
 * truth for both edge validation (ADR-006) and the generated OpenAPI spec
 * (ADR-004) — the contract is the product. Named via `.openapi(name)` so they
 * surface as reusable `#/components/schemas` entries.
 */

const idExample = '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33';
const nlIdExample = '9f21-2b0e5d8a1c33-4a7f2c1e-6b1a';

const segmentTagsField = z
  .array(z.string().trim().min(1).max(64))
  .openapi({ example: ['vip', 'beta'] });

const StatsSchema = z
  .object({
    recipients: z.number().int(),
    accepted: z.number().int(),
    delivered: z.number().int(),
    softBounced: z.number().int(),
    bounced: z.number().int(),
    complained: z.number().int(),
  })
  .openapi('CampaignStats');

export const CampaignSchema = z
  .object({
    id: z.string().openapi({ example: idExample }),
    newsletterId: z.string().openapi({ example: nlIdExample }),
    name: z.string().openapi({ example: 'March Dispatch' }),
    templateId: z.string().nullable().openapi({ example: null }),
    subject: z.string().nullable().openapi({ example: 'This month in review' }),
    bodyHtml: z.string().nullable().openapi({ example: '<h1>Hello</h1>' }),
    bodyText: z.string().nullable().openapi({ example: 'Hello' }),
    segmentTags: z.array(z.string()).openapi({ example: ['vip'] }),
    status: z.enum(CAMPAIGN_STATUSES).openapi({ example: 'draft' }),
    sendId: z.string().nullable().openapi({ example: null }),
    stats: StatsSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sentAt: z.string().datetime().nullable(),
  })
  .openapi('Campaign');

// Content requires exactly one source: a templateId, or inline subject+bodyHtml.
export const CreateCampaignSchema = z
  .object({
    newsletterId: z.string().trim().min(1).openapi({ example: nlIdExample }),
    name: z.string().trim().min(1).max(200).openapi({ example: 'March Dispatch' }),
    templateId: z.string().trim().min(1).nullish().openapi({ example: null }),
    subject: z.string().trim().min(1).max(998).nullish().openapi({ example: 'This month in review' }),
    bodyHtml: z.string().min(1).nullish().openapi({ example: '<h1>Hello {{firstName}}</h1>' }),
    bodyText: z.string().nullish().openapi({ example: 'Hello' }),
    segmentTags: segmentTagsField.optional(),
  })
  .refine((v) => v.templateId != null || (v.subject != null && v.bodyHtml != null), {
    message: 'requires a templateId or inline subject and bodyHtml',
    path: ['content'],
  })
  .openapi('CreateCampaign');

export const UpdateCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    templateId: z.string().trim().min(1).nullish(),
    subject: z.string().trim().min(1).max(998).nullish(),
    bodyHtml: z.string().min(1).nullish(),
    bodyText: z.string().nullish(),
    segmentTags: segmentTagsField.optional(),
  })
  .openapi('UpdateCampaign');

export const CampaignListSchema = listResponseSchema(CampaignSchema, 'CampaignList');

/** Query filters for the list route: pagination + newsletter/status filters. */
export const ListCampaignsQuerySchema = paginationQuerySchema.extend({
  newsletterId: z.string().trim().min(1).optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

export const CampaignIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, example: idExample }),
});

const RecipientOutcomeSchema = z
  .object({
    address: z.string().email(),
    messageId: z.string().nullable(),
    status: z.enum(OUTCOME_STATUSES),
    opens: z.number().int(),
    clicks: z.number().int(),
    updatedAt: z.string().datetime(),
  })
  .openapi('RecipientOutcome');

/**
 * A send's submission facts plus **live** stats. Recipients are deliberately
 * NOT inlined (ADR-019): at 18k recipients that is a multi-megabyte response.
 * They are a separate paginated resource, `GET /campaigns/{id}/send/recipients`.
 */
export const SendSchema = z
  .object({
    id: z.string(),
    campaignId: z.string(),
    bulkRequestId: z.string().nullable(),
    submittedAt: z.string().datetime().nullable(),
    recipientCount: z.number().int(),
    stats: StatsSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Send');

export const RecipientOutcomeListSchema = listResponseSchema(
  RecipientOutcomeSchema,
  'RecipientOutcomeList',
);

/** Query filters for the recipients list: pagination + status segment. */
export const ListRecipientOutcomesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(OUTCOME_STATUSES).optional(),
  /** Convenience: bounced + complained in one filter. */
  failuresOnly: z.coerce.boolean().optional(),
});

export const WebhookAckSchema = z.object({ status: z.string() }).openapi('WebhookAck');

/**
 * One kind of provider event the receiver took but did not act on (ADR-021).
 * A non-empty list is the signal that Postmark is sending something cablegram
 * drops — the question a log line on an ephemeral function cannot answer.
 */
const UnhandledEventSchema = z
  .object({
    key: z.string().openapi({
      description:
        'The bucket: a Postmark RecordType, a RecordType:Detail pair when the type is handled ' +
        'but a sub-case is not (e.g. Bounce:NewType), or `__unparseable` for a body with no ' +
        'usable RecordType.',
      example: 'SubscriptionChange',
    }),
    count: z.number().int().openapi({ example: 4203 }),
    sample: z.string().openapi({
      description: 'The first payload seen for this key, JSON-serialized and truncated.',
      example: '{"RecordType":"SubscriptionChange","Recipient":"reader@example.com"}',
    }),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .openapi('UnhandledEvent');

/**
 * Not the paginated list envelope: the collection is one row per *kind* of
 * event, bounded by Postmark's record-type table rather than by traffic, so
 * there is never a second page to fetch.
 */
export const UnhandledEventListSchema = z
  .object({ data: z.array(UnhandledEventSchema) })
  .openapi('UnhandledEventList');

/** Permissive Postmark webhook body: an event object with a `RecordType`. */
export const PostmarkWebhookSchema = z
  .record(z.unknown())
  .openapi('PostmarkWebhookEvent', { example: { RecordType: 'Delivery' } });

export type CampaignResponse = z.infer<typeof CampaignSchema>;
export type SendResponse = z.infer<typeof SendSchema>;
export type RecipientOutcomeResponse = z.infer<typeof RecipientOutcomeSchema>;
export type UnhandledEventResponse = z.infer<typeof UnhandledEventSchema>;

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toCampaignResponse(campaign: Campaign): CampaignResponse {
  return {
    id: campaign.id,
    newsletterId: campaign.newsletterId,
    name: campaign.name,
    templateId: campaign.templateId,
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    bodyText: campaign.bodyText,
    segmentTags: [...campaign.segmentTags],
    status: campaign.status,
    sendId: campaign.sendId,
    stats: { ...campaign.stats },
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    sentAt: campaign.sentAt?.toISOString() ?? null,
  };
}

/** Maps a send + its live stats to the wire DTO. */
export function toSendResponse(send: Send, stats: CampaignStats): SendResponse {
  return {
    id: send.id,
    campaignId: send.campaignId,
    bulkRequestId: send.bulkRequestId,
    submittedAt: send.submittedAt?.toISOString() ?? null,
    recipientCount: send.recipientCount,
    stats,
    createdAt: send.createdAt.toISOString(),
    updatedAt: send.updatedAt.toISOString(),
  };
}

/** Maps one unhandled-event bucket to its wire DTO. */
export function toUnhandledEventResponse(record: UnhandledEventRecord): UnhandledEventResponse {
  return {
    key: record.key,
    count: record.count,
    sample: record.sample,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
  };
}

/** Maps one recipient outcome to its wire DTO. */
export function toRecipientOutcomeResponse(outcome: RecipientOutcome): RecipientOutcomeResponse {
  return {
    address: outcome.address,
    messageId: outcome.messageId,
    status: outcome.status,
    opens: outcome.opens,
    clicks: outcome.clicks,
    updatedAt: outcome.updatedAt.toISOString(),
  };
}
