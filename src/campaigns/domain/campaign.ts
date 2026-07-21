import type { Id } from '../../shared/ids/index.js';
import { InvalidCampaignError, CampaignStateError } from './errors.js';

/**
 * A campaign's identity. A light alias over the app-owned string `Id`
 * (ADR-012) — a plain `_id`, never a Mongo `ObjectId` — for intent at call
 * sites. Still assignable to/from `string`.
 */
export type CampaignId = Id;

/**
 * The campaign lifecycle (ADR-011). A closed set so every caller and the send
 * pipeline agree on the vocabulary:
 * - `draft`     — created, editable, not yet sent.
 * - `scheduled` — queued for a future send (no scheduler in this chunk; the
 *   send path still accepts it as a sendable pre-send state).
 * - `sending`   — a send is in flight; persisted **before** the provider call so
 *   a crash leaves a recoverable state reconciled by webhooks (ADR-008).
 * - `sent`      — the provider accepted the broadcast; re-sending is a no-op.
 * - `failed`    — the provider call threw; the campaign may be re-sent (retry).
 */
export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed'] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export function isCampaignStatus(value: string): value is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * Aggregate delivery stats for a campaign's one send (ADR-008). Set from the
 * provider response at send time (`recipients`/`accepted`/`rejected`) and
 * updated from the send record as webhooks arrive
 * (`delivered`/`bounced`/`complained`). A full snapshot, recomputed from the
 * authoritative send record — never incremented — so it is order-independent.
 */
export interface CampaignStats {
  /** Addresses handed to the provider after both send gates. */
  recipients: number;
  /** Provider-accepted at send. */
  accepted: number;
  /** Provider-rejected at send. */
  rejected: number;
  delivered: number;
  bounced: number;
  complained: number;
}

export function zeroStats(): CampaignStats {
  return { recipients: 0, accepted: 0, rejected: 0, delivered: 0, bounced: 0, complained: 0 };
}

/** The content source a send renders (a template reference or inline bodies). */
export interface CampaignContentRef {
  readonly templateId: string | null;
  readonly subject: string | null;
  readonly bodyHtml: string | null;
  readonly bodyText: string | null;
}

/** A query-time segment: subscriptions carrying **every** listed tag (AND); empty = all. */
export interface CampaignSegment {
  readonly tags: readonly string[];
}

/** Fully-resolved campaign state; the shape a repository reconstitutes from. */
export interface CampaignProps {
  id: CampaignId;
  /** The newsletter this campaign belongs to (an id reference, ADR-012). */
  newsletterId: string;
  name: string;
  /** Reference to a reusable template, or `null` when the content is inline. */
  templateId: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  /** Query-time segment tags (AND); empty targets the whole subscribed list. */
  segmentTags: string[];
  status: CampaignStatus;
  /**
   * A future send time (ADR-009's open scheduling item), or `null` for a plain
   * draft. Setting it is what drives `status` to `scheduled`; an external cron
   * hitting `POST /v1/campaigns/dispatch-due` is the only thing that acts on it
   * — there is no in-process timer (ADR-009: ephemeral, no background workers).
   */
  scheduledAt: Date | null;
  /** The id of this campaign's one `SendRecord`, set when a send begins. */
  sendId: string | null;
  stats: CampaignStats;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

/** Fields accepted when creating a campaign (primitives at the boundary). */
export interface CreateCampaignProps {
  id: CampaignId;
  newsletterId: string;
  name: string;
  templateId?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  segmentTags?: string[];
  /** A future send time; when set the campaign starts `scheduled` instead of `draft`. */
  scheduledAt?: Date | null;
  now: Date;
}

/** Fields that may be changed on a not-yet-sent campaign; omitted = unchanged. */
export interface UpdateCampaignProps {
  name?: string;
  templateId?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  segmentTags?: string[];
  /**
   * Setting a future time (re)schedules the campaign (`draft`/`failed` →
   * `scheduled`); explicitly setting `null` unschedules it back to `draft`.
   * Omit to leave the schedule untouched.
   */
  scheduledAt?: Date | null;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidCampaignError(field, 'must not be empty');
  }
  return trimmed;
}

// Optional body/reference fields normalize empty/whitespace to `null`.
function optionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Tags are trimmed, de-duplicated (order preserved) and stripped of empties so
// query-time segment matching is exact and stable (mirrors `subscriptions`).
function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0) {
      throw new InvalidCampaignError('segmentTags', 'must not contain empty tags');
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * A campaign's content must have exactly one usable source: a `templateId`
 * reference, **or** inline `subject` + `bodyHtml`. `bodyText` is always
 * optional (the renderer derives text from HTML when absent).
 */
function validateContent(
  templateId: string | null,
  subject: string | null,
  bodyHtml: string | null,
): void {
  if (templateId !== null) return;
  if (subject === null || bodyHtml === null) {
    throw new InvalidCampaignError(
      'content',
      'requires a templateId or inline subject and bodyHtml',
    );
  }
}

// A schedule must be a real future moment — a past/now time would be "due"
// the instant it's created, indistinguishable from just sending it directly,
// and more likely a caller's clock/timezone mistake than an intent to send
// immediately (that's what `POST /{id}/send` is for).
function validateScheduledAt(scheduledAt: Date | null, now: Date): void {
  if (scheduledAt !== null && scheduledAt.getTime() <= now.getTime()) {
    throw new InvalidCampaignError('scheduledAt', 'must be a future time');
  }
}

/**
 * The campaign aggregate (ADR-011): a broadcast a newsletter sends to a
 * query-time segment of its subscribers, resolving content from a template
 * reference or inline bodies. It owns the send state machine
 * (`draft → sending → sent | failed`) and the aggregate delivery stats; the
 * per-recipient outcomes live in the sibling `SendRecord`.
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage), so
 * an instance is always valid.
 */
export class Campaign {
  private constructor(private props: CampaignProps) {}

  static create(input: CreateCampaignProps): Campaign {
    const templateId = optionalText(input.templateId);
    const subject = optionalText(input.subject);
    const bodyHtml = optionalText(input.bodyHtml);
    validateContent(templateId, subject, bodyHtml);
    const scheduledAt = input.scheduledAt ?? null;
    validateScheduledAt(scheduledAt, input.now);

    return new Campaign({
      id: input.id,
      newsletterId: requireText(input.newsletterId, 'newsletterId'),
      name: requireText(input.name, 'name'),
      templateId,
      subject,
      bodyHtml,
      bodyText: optionalText(input.bodyText),
      segmentTags: normalizeTags(input.segmentTags),
      status: scheduledAt === null ? 'draft' : 'scheduled',
      scheduledAt,
      sendId: null,
      stats: zeroStats(),
      createdAt: input.now,
      updatedAt: input.now,
      sentAt: null,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: CampaignProps): Campaign {
    return new Campaign(props);
  }

  /** `true` while the campaign may still be edited or sent (not sent/sending). */
  private get isEditable(): boolean {
    return this.props.status === 'draft' || this.props.status === 'scheduled' || this.props.status === 'failed';
  }

  /**
   * Apply a partial change set. Only a not-yet-sent campaign is editable; an
   * in-flight or completed one refuses. Re-validates the (possibly changed)
   * content source and bumps `updatedAt`.
   */
  update(changes: UpdateCampaignProps, now: Date): void {
    if (!this.isEditable) {
      throw new CampaignStateError(`cannot edit a campaign in status "${this.props.status}"`);
    }
    const next: CampaignProps = { ...this.props };

    if (changes.name !== undefined) next.name = requireText(changes.name, 'name');
    if (changes.templateId !== undefined) next.templateId = optionalText(changes.templateId);
    if (changes.subject !== undefined) next.subject = optionalText(changes.subject);
    if (changes.bodyHtml !== undefined) next.bodyHtml = optionalText(changes.bodyHtml);
    if (changes.bodyText !== undefined) next.bodyText = optionalText(changes.bodyText);
    if (changes.segmentTags !== undefined) next.segmentTags = normalizeTags(changes.segmentTags);
    if (changes.scheduledAt !== undefined) {
      validateScheduledAt(changes.scheduledAt, now);
      next.scheduledAt = changes.scheduledAt;
      // (Re)scheduling: a `draft`/`failed` campaign given a future time
      // becomes `scheduled`. Unscheduling (`scheduledAt: null`) drops a
      // `scheduled` campaign back to `draft`; on any other status it's a no-op
      // beyond clearing the field.
      if (changes.scheduledAt !== null) {
        next.status = 'scheduled';
      } else if (next.status === 'scheduled') {
        next.status = 'draft';
      }
    }

    validateContent(next.templateId, next.subject, next.bodyHtml);
    next.updatedAt = now;
    this.props = next;
  }

  /**
   * Begin a send: transition a sendable campaign to `sending` and bind it to a
   * fresh send record. Persisted **before** the provider call (ADR-008). Only
   * `draft`/`scheduled`/`failed` may transition; `sending`/`sent` refuse.
   */
  markSending(sendId: string, now: Date): void {
    if (!this.isEditable) {
      throw new CampaignStateError(`cannot send a campaign in status "${this.props.status}"`);
    }
    this.props = { ...this.props, status: 'sending', sendId, stats: zeroStats(), updatedAt: now };
  }

  /** Complete the send: record the accepted stats and mark `sent`. */
  markSent(stats: CampaignStats, now: Date): void {
    this.props = { ...this.props, status: 'sent', stats, sentAt: now, updatedAt: now };
  }

  /** Abandon an in-flight send: mark `failed` so it may be retried. */
  markFailed(now: Date): void {
    this.props = { ...this.props, status: 'failed', updatedAt: now };
  }

  /**
   * Replace the aggregate stats from the authoritative send record (a full
   * recompute driven by webhooks) — idempotent and order-independent.
   */
  applyStats(stats: CampaignStats, now: Date): void {
    this.props = { ...this.props, stats, updatedAt: now };
  }

  /** The content source a send renders. */
  contentRef(): CampaignContentRef {
    return {
      templateId: this.props.templateId,
      subject: this.props.subject,
      bodyHtml: this.props.bodyHtml,
      bodyText: this.props.bodyText,
    };
  }

  /** The query-time recipient segment (empty tags = the whole subscribed list). */
  segment(): CampaignSegment {
    return { tags: this.props.segmentTags };
  }

  get id(): CampaignId {
    return this.props.id;
  }
  get newsletterId(): string {
    return this.props.newsletterId;
  }
  get name(): string {
    return this.props.name;
  }
  get templateId(): string | null {
    return this.props.templateId;
  }
  get subject(): string | null {
    return this.props.subject;
  }
  get bodyHtml(): string | null {
    return this.props.bodyHtml;
  }
  get bodyText(): string | null {
    return this.props.bodyText;
  }
  get segmentTags(): readonly string[] {
    return this.props.segmentTags;
  }
  get status(): CampaignStatus {
    return this.props.status;
  }
  get scheduledAt(): Date | null {
    return this.props.scheduledAt;
  }
  get isSent(): boolean {
    return this.props.status === 'sent';
  }
  get sendId(): string | null {
    return this.props.sendId;
  }
  get stats(): CampaignStats {
    return this.props.stats;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get sentAt(): Date | null {
    return this.props.sentAt;
  }
}
