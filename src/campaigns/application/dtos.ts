import type { CampaignStatus } from '../domain/campaign.js';

/**
 * Application-layer input DTOs: plain, validated primitives handed to use cases
 * (ADR-006 — validation happens at the HTTP edge; use cases never see a Hono
 * `Context`). Output is the domain `Campaign`/`SendRecord`, mapped to a response
 * DTO by the presentation layer — entities are never serialized directly (ADR-004).
 */

export interface CreateCampaignInput {
  newsletterId: string;
  name: string;
  templateId?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  /** Query-time segment tags (AND); omitted/empty targets the whole subscribed list. */
  segmentTags?: string[];
}

export interface UpdateCampaignInput {
  name?: string;
  templateId?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  segmentTags?: string[];
}

export interface ListCampaignsInput {
  /** Optional filters (not materialized segments). */
  newsletterId?: string;
  status?: CampaignStatus;
  /** Page size requested by the caller. */
  limit: number;
  cursor?: string;
}
