import { z } from '@hono/zod-openapi';
import { listResponseSchema } from '../../shared/http/index.js';
import { SUPPRESSION_REASONS, type SuppressionEntry } from '../domain/suppression.js';

/**
 * zod-OpenAPI schemas for the deliverability API. These are the single source
 * of truth for both edge validation (ADR-006) and the generated OpenAPI spec
 * (ADR-004) — the contract is the product.
 */

const reasonField = z.enum(SUPPRESSION_REASONS).openapi({ example: 'hard-bounce' });

export const SuppressionSchema = z
  .object({
    address: z.string().email().openapi({ example: 'bounced@dispatch.example' }),
    reason: reasonField,
    createdAt: z.string().datetime(),
  })
  .openapi('Suppression');

export const AddSuppressionSchema = z
  .object({
    address: z.string().trim().email().max(320).openapi({ example: 'bounced@dispatch.example' }),
    reason: reasonField,
  })
  .openapi('AddSuppression');

export const SuppressionListSchema = listResponseSchema(SuppressionSchema, 'SuppressionList');

export const SuppressionAddressParamSchema = z.object({
  address: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'address', in: 'path' },
      example: 'bounced@dispatch.example',
    }),
});

export type SuppressionResponse = z.infer<typeof SuppressionSchema>;

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toSuppressionResponse(entry: SuppressionEntry): SuppressionResponse {
  return {
    address: entry.address,
    reason: entry.reason,
    createdAt: entry.createdAt.toISOString(),
  };
}
