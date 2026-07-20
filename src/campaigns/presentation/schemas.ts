import { z } from '@hono/zod-openapi';
import { listResponseSchema, paginationQuerySchema } from '../../shared/http/index.js';
import { CAMPAIGN_STATUSES, type Campaign } from '../domain/campaign.js';
import type { SendRecord } from '../domain/send-record.js';
import { OUTCOME_STATUSES } from '../domain/send-record.js';
import { DEFAULT_DISPATCH_BATCH, MAX_DISPATCH_BATCH } from '../application/dtos.js';

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
    rejected: z.number().int(),
    delivered: z.number().int(),
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
    scheduledAt: z.string().datetime().nullable().openapi({ example: null }),
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
    scheduledAt: z
      .string()
      .datetime()
      .nullish()
      .openapi({ example: null, description: 'A future send time; sets the campaign to `scheduled` instead of `draft`.' }),
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
    scheduledAt: z
      .string()
      .datetime()
      .nullish()
      .openapi({ description: 'A future time to reschedule to, or `null` to unschedule back to draft.' }),
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
    errorCode: z.number().int(),
    opens: z.number().int(),
    clicks: z.number().int(),
  })
  .openapi('RecipientOutcome');

export const SendRecordSchema = z
  .object({
    id: z.string(),
    campaignId: z.string(),
    stats: StatsSchema,
    recipients: z.array(RecipientOutcomeSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('SendRecord');

/** Query params for the scheduling dispatch sweep (ADR-009's open item). */
export const DispatchDueQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_DISPATCH_BATCH)
    .optional()
    .openapi({
      param: { name: 'limit', in: 'query' },
      description: `Max due campaigns to send in this call (default ${DEFAULT_DISPATCH_BATCH}, capped at ${MAX_DISPATCH_BATCH}).`,
      example: DEFAULT_DISPATCH_BATCH,
    }),
});

const DispatchDueResultSchema = z
  .object({
    campaignId: z.string().openapi({ example: idExample }),
    status: z.enum(CAMPAIGN_STATUSES).openapi({ example: 'sent' }),
  })
  .openapi('DispatchDueResult');

export const DispatchDueResponseSchema = z
  .object({
    data: z.array(DispatchDueResultSchema),
    meta: z.object({ dispatched: z.number().int() }),
  })
  .openapi('DispatchDueResponse');

export const WebhookAckSchema = z.object({ status: z.string() }).openapi('WebhookAck');

/** Permissive Postmark webhook body: an event object with a `RecordType`. */
export const PostmarkWebhookSchema = z
  .record(z.unknown())
  .openapi('PostmarkWebhookEvent', { example: { RecordType: 'Delivery' } });

export type CampaignResponse = z.infer<typeof CampaignSchema>;
export type SendRecordResponse = z.infer<typeof SendRecordSchema>;

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
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    sendId: campaign.sendId,
    stats: { ...campaign.stats },
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    sentAt: campaign.sentAt?.toISOString() ?? null,
  };
}

/** Maps a send record to its wire DTO (per-recipient outcomes + derived stats). */
export function toSendRecordResponse(record: SendRecord): SendRecordResponse {
  return {
    id: record.id,
    campaignId: record.campaignId,
    stats: record.stats(),
    recipients: record.outcomes.map((o) => ({
      address: o.address,
      messageId: o.messageId,
      status: o.status,
      errorCode: o.errorCode,
      opens: o.opens,
      clicks: o.clicks,
    })),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
