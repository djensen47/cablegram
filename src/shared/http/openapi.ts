import { z } from '@hono/zod-openapi';
import type { Hook } from '@hono/zod-openapi';
import type { AppEnv } from './app-env.js';

/**
 * Shared zod-OpenAPI scaffolding for the presentation edge (ADR-006). Every
 * component's router validates at the edge and renders the same
 * `{ error: { code, ... } }` envelope (ADR-004), lists through the same
 * cursor-paginated shape, and rejects invalid input the same way — so the
 * pieces that do not vary by component live here once, in the http leaf, rather
 * than being reinvented per router.
 */

/** The stable JSON error body every route can return (mirrors `onError`). */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  })
  .openapi('Error');

/**
 * `defaultHook` for an `OpenAPIHono`: route validation failures out through the
 * shared error envelope by rethrowing the `ZodError`, which `onError` then
 * renders as `{ error: { code, ... } }` (ADR-004).
 */
export const throwOnInvalid: Hook<unknown, AppEnv, string, unknown> = (result) => {
  if (!result.success) {
    throw result.error as z.ZodError;
  }
};

/** An `application/json` error response body for an OpenAPI route, by description. */
export function errorResponse(description: string) {
  return {
    content: { 'application/json': { schema: ErrorSchema } },
    description,
  } as const;
}

/**
 * The cursor-paginated list envelope `{ data: [...], meta: { nextCursor } }` as
 * a named OpenAPI component schema — the wire shape `toPage` produces. `name` is
 * the `#/components/schemas` entry (e.g. `NewsletterList`).
 */
export function listResponseSchema<T extends z.ZodTypeAny>(item: T, name: string) {
  return z
    .object({
      data: z.array(item),
      meta: z.object({ nextCursor: z.string().nullable() }),
    })
    .openapi(name);
}
