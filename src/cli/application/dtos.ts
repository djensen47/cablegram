/**
 * The `/v1` wire DTOs the CLI consumes (ADR-016 §1).
 *
 * These are hand-mirrored from each component's `presentation/schemas.ts`
 * rather than imported: importing them would make `src/cli/` depend on a domain
 * component, which is exactly the edge this design forbids and ESLint rejects
 * (ADR-005). Duplication is the price of the CLI genuinely being an external
 * client — it sees the contract, not the code.
 *
 * They are also intentionally read-only and structural: if a field is added
 * server-side, the CLI keeps working; if one is removed or renamed, the CLI's
 * tests fail, which is the pressure on contract stability ADR-016 is after.
 */

export interface ListEnvelope<T> {
  data: T[];
  meta: { nextCursor: string | null };
}

export interface UserDto {
  id: string;
  email: string;
  role: 'admin' | 'manager';
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterDto {
  id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  sendingDomain: string | null;
  dkimIdentifier: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The membership lifecycle, mirrored from the API contract. A value (not just a
 * type) because the import path has to *validate* a CSV cell against it and
 * name the legal values in the error — the same reason the server keeps
 * `SUBSCRIPTION_STATUSES` as a const array.
 */
export const SUBSCRIPTION_STATUSES = [
  'pending',
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface SubscriptionDto {
  id: string;
  newsletterId: string;
  email: string;
  status: SubscriptionStatus;
  customFields: Record<string, unknown>;
  tags: string[];
  /** Provenance when the record was imported; `null` when cablegram collected it. */
  source: string | null;
  /** The consent record (ADR-023) — all nullable; absence means never observed. */
  signupIp: string | null;
  signupUserAgent: string | null;
  /** When double opt-in completed; `null` on a single-opt-in row. */
  confirmedAt: string | null;
  confirmedIp: string | null;
  confirmedUserAgent: string | null;
  unsubscribedAt: string | null;
  unsubscribedIp: string | null;
  unsubscribedUserAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What one `POST .../subscriptions/import` batch did (ADR-022). */
export interface ImportResultDto {
  received: number;
  created: number;
  updated: number;
  skipped: number;
  /** Imported hard bounces added to the global suppression list. */
  suppressed: number;
  byStatus: Partial<Record<SubscriptionStatus, number>>;
}

export interface TemplateDto {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CampaignStatus = 'draft' | 'sending' | 'sent' | 'failed';

export interface CampaignStatsDto {
  recipients: number;
  accepted: number;
  delivered: number;
  softBounced: number;
  bounced: number;
  complained: number;
}

export interface CampaignDto {
  id: string;
  newsletterId: string;
  name: string;
  templateId: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  segmentTags: string[];
  status: CampaignStatus;
  sendId: string | null;
  stats: CampaignStatsDto;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/**
 * What a test send delivered (ADR-025). There is no resource behind it — a test
 * send records nothing server-side, so this response is the whole record of it.
 */
export interface TestSendDto {
  campaignId: string;
  /** The subject as actually submitted, `[TEST] ` prefix included when applied. */
  subject: string;
  sent: string[];
  /** Requested addresses dropped because they are on the global suppression list. */
  suppressed: string[];
  bulkRequestId: string | null;
}

export interface RecipientOutcomeDto {
  address: string;
  messageId: string | null;
  status: string;
  opens: number;
  clicks: number;
  updatedAt: string;
}

/**
 * A send's submission facts + live stats. Recipients are deliberately NOT
 * inlined — they are a separate cursor-paginated resource, because at 18k
 * recipients an inline array is a multi-megabyte response.
 */
export interface SendDto {
  id: string;
  campaignId: string;
  bulkRequestId: string | null;
  submittedAt: string | null;
  recipientCount: number;
  stats: CampaignStatsDto;
  createdAt: string;
  updatedAt: string;
}

/**
 * One kind of provider event the receiver took but did not act on. Not wrapped
 * in `ListEnvelope`: the endpoint is unpaginated because the collection is
 * bounded by the provider's record-type table rather than by traffic.
 */
export interface UnhandledEventDto {
  key: string;
  count: number;
  sample: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type SuppressionReason = string;

export interface SuppressionDto {
  address: string;
  reason: SuppressionReason;
  createdAt: string;
}
