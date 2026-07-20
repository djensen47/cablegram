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
  /** A future send time; when set the campaign starts `scheduled` instead of `draft`. */
  scheduledAt?: Date | null;
}

export interface UpdateCampaignInput {
  name?: string;
  templateId?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  segmentTags?: string[];
  /** Reschedule (a future time) or unschedule (`null`); omit to leave as-is. */
  scheduledAt?: Date | null;
}

export interface ListCampaignsInput {
  /** Optional filters (not materialized segments). */
  newsletterId?: string;
  status?: CampaignStatus;
  /** Page size requested by the caller. */
  limit: number;
  cursor?: string;
}

/** Input for the scheduling dispatch sweep (ADR-009's open item). */
export interface DispatchDueCampaignsInput {
  /** Max due campaigns to send in this call; clamped to `MAX_DISPATCH_BATCH`. */
  limit?: number;
}

/** One campaign's outcome from a dispatch sweep. */
export interface DispatchDueResult {
  campaignId: string;
  status: CampaignStatus;
}

/** Default/ceiling batch size for one `dispatch-due` call (ADR-009: respect
 * the function time-limit posture — a single invocation sends a bounded batch,
 * not the whole due set; an external cron simply calls again for the rest). */
export const DEFAULT_DISPATCH_BATCH = 20;
export const MAX_DISPATCH_BATCH = 50;
