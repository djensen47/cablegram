import { z } from '@hono/zod-openapi';
import { listResponseSchema } from '../../shared/http/index.js';
import type { Newsletter } from '../domain/newsletter.js';

/**
 * zod-OpenAPI schemas for the newsletters API. These are the single source of
 * truth for both edge validation (ADR-006) and the generated OpenAPI spec
 * (ADR-004) — the contract is the product. Named via `.openapi(name)` so they
 * surface as reusable `#/components/schemas` entries.
 */

const emailField = z.string().trim().email().max(320);

// Mirrors the domain's loose check: a provider-chosen identifier (for Postmark,
// a broadcast message stream ID), so only whitespace and length are refused.
const sendingChannelField = z
  .string()
  .trim()
  .regex(/^\S{1,100}$/, 'must be 1-100 characters with no whitespace');

const SENDING_CHANNEL_DESCRIPTION =
  'The provider sending channel this newsletter\u2019s campaigns go through (ADR-030). For ' +
  'Postmark, the ID of a broadcast message stream \u2014 one stream per newsletter keeps each ' +
  'newsletter\u2019s opt-outs separate.'

export const NewsletterSchema = z
  .object({
    id: z.string().openapi({ example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33' }),
    name: z.string().openapi({ example: 'The Weekly Dispatch' }),
    fromName: z.string().openapi({ example: 'Dispatch Editors' }),
    fromEmail: z.string().email().openapi({ example: 'editors@dispatch.example' }),
    replyTo: z.string().email().nullable().openapi({ example: 'replies@dispatch.example' }),
    sendingDomain: z.string().nullable().openapi({ example: 'mail.dispatch.example' }),
    dkimIdentifier: z.string().nullable().openapi({ example: 'pm' }),
    sendingChannel: z.string().nullable().openapi({
      description:
        `${SENDING_CHANNEL_DESCRIPTION} \`null\` only on a newsletter created before the field ` +
        'existed; it cannot send until one is set.',
      example: 'weekly-dispatch',
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Newsletter');

export const CreateNewsletterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ example: 'The Weekly Dispatch' }),
    fromName: z.string().trim().min(1).max(200).openapi({ example: 'Dispatch Editors' }),
    fromEmail: emailField.openapi({ example: 'editors@dispatch.example' }),
    replyTo: emailField.nullish().openapi({ example: 'replies@dispatch.example' }),
    sendingDomain: z.string().trim().max(253).nullish().openapi({ example: 'mail.dispatch.example' }),
    dkimIdentifier: z.string().trim().max(64).nullish().openapi({ example: 'pm' }),
    sendingChannel: sendingChannelField.openapi({
      description: `${SENDING_CHANNEL_DESCRIPTION} Required; there is no default.`,
      example: 'weekly-dispatch',
    }),
  })
  .openapi('CreateNewsletter');

export const UpdateNewsletterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    fromName: z.string().trim().min(1).max(200).optional(),
    fromEmail: emailField.optional(),
    replyTo: emailField.nullish(),
    sendingDomain: z.string().trim().max(253).nullish(),
    dkimIdentifier: z.string().trim().max(64).nullish(),
    // Changeable, never clearable: a newsletter without one cannot send.
    sendingChannel: sendingChannelField.optional().openapi({
      description: `${SENDING_CHANNEL_DESCRIPTION} Can be changed but not cleared.`,
      example: 'weekly-dispatch',
    }),
  })
  .openapi('UpdateNewsletter');

export const NewsletterListSchema = listResponseSchema(NewsletterSchema, 'NewsletterList');

export const NewsletterIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33',
    }),
});

export type NewsletterResponse = z.infer<typeof NewsletterSchema>;

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toNewsletterResponse(newsletter: Newsletter): NewsletterResponse {
  return {
    id: newsletter.id,
    name: newsletter.name,
    fromName: newsletter.fromName,
    fromEmail: newsletter.fromEmail.value,
    replyTo: newsletter.replyTo?.value ?? null,
    sendingDomain: newsletter.sendingDomain,
    dkimIdentifier: newsletter.dkimIdentifier,
    sendingChannel: newsletter.sendingChannel,
    createdAt: newsletter.createdAt.toISOString(),
    updatedAt: newsletter.updatedAt.toISOString(),
  };
}
