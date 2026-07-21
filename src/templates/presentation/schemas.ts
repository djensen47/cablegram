import { z } from '@hono/zod-openapi';
import { listResponseSchema } from '../../shared/http/index.js';
import type { Template } from '../domain/template.js';

/**
 * zod-OpenAPI schemas for the templates API. These are the single source of
 * truth for both edge validation (ADR-006) and the generated OpenAPI spec
 * (ADR-004) — the contract is the product. Named via `.openapi(name)` so they
 * surface as reusable `#/components/schemas` entries.
 */

const bodyHtmlField = z.string().trim().min(1).max(200_000);

export const TemplateSchema = z
  .object({
    id: z.string().openapi({ example: '7e4b8b0e-2f2a-4d7a-9d3e-1b5c6a2f9e10' }),
    name: z.string().openapi({ example: 'Weekly digest' }),
    subject: z.string().openapi({ example: 'Your {{weekOf}} digest' }),
    bodyHtml: z.string().openapi({ example: '<p>Hi {{firstName}}, here is your digest.</p>' }),
    bodyText: z.string().nullable().openapi({ example: 'Hi {{firstName}}, here is your digest.' }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Template');

export const CreateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ example: 'Weekly digest' }),
    subject: z.string().trim().min(1).max(500).openapi({ example: 'Your {{weekOf}} digest' }),
    bodyHtml: bodyHtmlField.openapi({ example: '<p>Hi {{firstName}}, here is your digest.</p>' }),
    bodyText: z
      .string()
      .trim()
      .max(200_000)
      .nullish()
      .openapi({ example: 'Hi {{firstName}}, here is your digest.' }),
  })
  .openapi('CreateTemplate');

export const UpdateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    subject: z.string().trim().min(1).max(500).optional(),
    bodyHtml: bodyHtmlField.optional(),
    bodyText: z.string().trim().max(200_000).nullish(),
  })
  .openapi('UpdateTemplate');

export const TemplateListSchema = listResponseSchema(TemplateSchema, 'TemplateList');

export const TemplateIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '7e4b8b0e-2f2a-4d7a-9d3e-1b5c6a2f9e10',
    }),
});

export type TemplateResponse = z.infer<typeof TemplateSchema>;

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toTemplateResponse(template: Template): TemplateResponse {
  return {
    id: template.id,
    name: template.name,
    subject: template.subject,
    bodyHtml: template.bodyHtml,
    bodyText: template.bodyText,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}
