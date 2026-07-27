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

export type SubscriptionStatus =
  | 'pending'
  | 'subscribed'
  | 'unsubscribed'
  | 'bounced'
  | 'complained';

export interface SubscriptionDto {
  id: string;
  newsletterId: string;
  email: string;
  status: SubscriptionStatus;
  mergeFields: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
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
  rejected: number;
  delivered: number;
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

export type SuppressionReason = string;

export interface SuppressionDto {
  address: string;
  reason: SuppressionReason;
  createdAt: string;
}
