/**
 * Application-layer input DTOs: plain, validated primitives handed to use
 * cases (ADR-006 — validation happens at the HTTP edge; use cases never see a
 * Hono `Context`). Output is the domain `Template`, mapped to a response DTO
 * by the presentation layer — entities are never serialized directly (ADR-004).
 */

export interface CreateTemplateInput {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string | null;
}

export interface UpdateTemplateInput {
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string | null;
}

export interface ListTemplatesInput {
  /** Page size requested by the caller. */
  limit: number;
  cursor?: string;
}
