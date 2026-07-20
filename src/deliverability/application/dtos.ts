import type { SuppressionReason } from '../domain/suppression.js';

/**
 * Application-layer input DTOs: plain, validated primitives handed to use
 * cases (ADR-006 — validation happens at the HTTP edge; use cases never see a
 * Hono `Context`). Output is the domain `SuppressionEntry`, mapped to a
 * response DTO by the presentation layer.
 */

export interface AddSuppressionInput {
  address: string;
  reason: SuppressionReason;
}

export interface ListSuppressionsInput {
  /** Page size requested by the caller. */
  limit: number;
  cursor?: string;
}
