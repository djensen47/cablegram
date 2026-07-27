import type { Id } from '../../shared/ids/index.js';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import {
  InvalidSubscriptionEmailError,
  InvalidSubscriptionError,
  SubscriptionStateError,
} from './errors.js';

/**
 * A subscription's identity. A light alias over the app-owned string `Id`
 * (ADR-012) — a plain `_id`, never a Mongo `ObjectId` — for intent at call
 * sites. Still assignable to/from `string`.
 */
export type SubscriptionId = Id;

// Same conservative address check as `newsletters`/`deliverability` (ADR-011:
// no shared `Contact` identity, but the *validation* shape is consistent
// everywhere an address is accepted at the boundary).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The subscription lifecycle (ADR-011, ADR-018). A closed set so every caller,
 * list filter and recipient resolver agrees on the vocabulary:
 * - `pending`      — created under double opt-in, awaiting confirmation.
 * - `subscribed`   — confirmed (or single opt-in); **the only sendable state**.
 * - `unsubscribed` — opted out; the row is kept so a re-subscribe revives it.
 * - `bounced`      — mail to this address failed permanently on this newsletter.
 * - `complained`   — reported this newsletter as spam.
 *
 * `bounced` and `complained` are stored per-newsletter even though a hard bounce
 * *also* lands on the global suppression list (ADR-018). They are not redundant:
 * they are the observed data point for **this** newsletter, and filtering
 * `status = bounced` on one newsletter is far cheaper than joining every
 * subscriber against a global deny-list.
 */
export const SUBSCRIPTION_STATUSES = [
  'pending',
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Arbitrary per-subscription personalization data — the "merge model" a
 * template renders against (`{{firstName}}`, …). An opaque bag: the
 * subscriptions context never interprets it, it just stores and hands it back.
 */
export type MergeFields = Record<string, unknown>;

/** Fully-resolved subscription state; the shape a repository reconstitutes from. */
export interface SubscriptionProps {
  id: SubscriptionId;
  /** The newsletter this membership belongs to (an id reference, ADR-012). */
  newsletterId: string;
  /** The subscriber address, normalized via the shared `email-address` module. */
  email: string;
  status: SubscriptionStatus;
  mergeFields: MergeFields;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when subscribing (primitives at the boundary). */
export interface CreateSubscriptionProps {
  id: SubscriptionId;
  newsletterId: string;
  email: string;
  mergeFields?: MergeFields;
  tags?: string[];
  /** Double opt-in → the subscription starts `pending`; single opt-in → `subscribed`. */
  doubleOptIn: boolean;
  now: Date;
}

/** Fields that may change when a lapsed row is revived (a re-subscribe). */
export interface ReviveSubscriptionProps {
  mergeFields?: MergeFields;
  tags?: string[];
  doubleOptIn: boolean;
  now: Date;
}

// Tags are trimmed, de-duplicated (order preserved) and stripped of empties so
// query-time segment matching is exact and stable.
function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0) {
      throw new InvalidSubscriptionError('tags', 'must not contain empty tags');
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function validEmail(raw: string): string {
  const normalized = normalizeEmailAddress(raw);
  if (!EMAIL_RE.test(normalized)) {
    throw new InvalidSubscriptionEmailError(raw);
  }
  return normalized;
}

/**
 * The subscription aggregate (ADR-011): a **flat, per-newsletter** membership.
 * There is deliberately no cross-newsletter `Contact` — the same address in two
 * newsletters is two independent `Subscription` rows, and the compound
 * `(newsletterId, email)` key (enforced by the repository) is what keeps a
 * single membership unique *within* one newsletter.
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage), so
 * an instance is always valid.
 */
export class Subscription {
  private constructor(private props: SubscriptionProps) {}

  static create(input: CreateSubscriptionProps): Subscription {
    return new Subscription({
      id: input.id,
      newsletterId: input.newsletterId,
      email: validEmail(input.email),
      status: input.doubleOptIn ? 'pending' : 'subscribed',
      mergeFields: input.mergeFields ?? {},
      tags: normalizeTags(input.tags),
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: SubscriptionProps): Subscription {
    return new Subscription(props);
  }

  /** `true` while awaiting double-opt-in confirmation (drives the DOI email). */
  get needsConfirmation(): boolean {
    return this.props.status === 'pending';
  }

  /**
   * Confirm a pending double-opt-in subscription. Idempotent on an already
   * `subscribed` row; refuses to confirm any lapsed one (that path is a
   * re-subscribe, not a confirm).
   */
  confirm(now: Date): void {
    if (this.props.status === 'subscribed') return;
    if (this.props.status !== 'pending') {
      throw new SubscriptionStateError(`cannot confirm a ${this.props.status} subscription`);
    }
    this.props = { ...this.props, status: 'subscribed', updatedAt: now };
  }

  /**
   * Mail to this address failed permanently **on this newsletter**. Recorded as
   * a status here; the global suppression list is written separately, because a
   * dead mailbox is a fact about the address rather than about this
   * relationship (ADR-018).
   *
   * Does not overwrite an explicit opt-out: someone who unsubscribed and later
   * bounces is still, primarily, someone who unsubscribed.
   */
  markBounced(now: Date): void {
    if (this.props.status === 'unsubscribed' || this.props.status === 'bounced') return;
    this.props = { ...this.props, status: 'bounced', updatedAt: now };
  }

  /**
   * Reported **this newsletter** as spam. Deliberately does *not* touch the
   * global suppression list (ADR-018): a complaint about one publication is not
   * a statement about every publication the operator runs. It is the strongest
   * per-newsletter signal there is, so it overrides anything except itself.
   */
  markComplained(now: Date): void {
    if (this.props.status === 'complained') return;
    this.props = { ...this.props, status: 'complained', updatedAt: now };
  }

  /** Opt the subscriber out. Idempotent: unsubscribing twice is a no-op. */
  unsubscribe(now: Date): void {
    if (this.props.status === 'unsubscribed') return;
    this.props = { ...this.props, status: 'unsubscribed', updatedAt: now };
  }

  /**
   * Revive a lapsed subscription (a re-subscribe, ADR-011): keep the same
   * row/id, refresh the merge model and tags, and re-enter the lifecycle at
   * `pending` (double opt-in) or `subscribed` (single opt-in).
   *
   * Legal from **every** lapsed state including `bounced` and `complained`
   * (ADR-018). Mailboxes get fixed and people genuinely re-opt-in; and for a
   * hard bounce the global suppression list is the real gate, so reviving the
   * row here cannot actually put mail back on the wire.
   */
  resubscribe(input: ReviveSubscriptionProps): void {
    this.props = {
      ...this.props,
      status: input.doubleOptIn ? 'pending' : 'subscribed',
      mergeFields: input.mergeFields ?? this.props.mergeFields,
      tags: input.tags === undefined ? this.props.tags : normalizeTags(input.tags),
      updatedAt: input.now,
    };
  }

  get id(): SubscriptionId {
    return this.props.id;
  }
  get newsletterId(): string {
    return this.props.newsletterId;
  }
  get email(): string {
    return this.props.email;
  }
  get status(): SubscriptionStatus {
    return this.props.status;
  }
  get mergeFields(): MergeFields {
    return this.props.mergeFields;
  }
  get tags(): readonly string[] {
    return this.props.tags;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
