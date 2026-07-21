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

export const NewsletterSchema = z
  .object({
    id: z.string().openapi({ example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33' }),
    name: z.string().openapi({ example: 'The Weekly Dispatch' }),
    fromName: z.string().openapi({ example: 'Dispatch Editors' }),
    fromEmail: z.string().email().openapi({ example: 'editors@dispatch.example' }),
    replyTo: z.string().email().nullable().openapi({ example: 'replies@dispatch.example' }),
    sendingDomain: z.string().nullable().openapi({ example: 'mail.dispatch.example' }),
    dkimIdentifier: z.string().nullable().openapi({ example: 'pm' }),
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
    createdAt: newsletter.createdAt.toISOString(),
    updatedAt: newsletter.updatedAt.toISOString(),
  };
}
