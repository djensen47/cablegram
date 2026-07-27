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

/**
 * Who did a consent-changing thing, as far as the operator could observe it
 * (ADR-023). Attached to the three moments that change consent: signing up,
 * confirming, and opting out.
 *
 * Both parts are optional and **both are unverified**. An IP is whatever the
 * operator's front end reported, or — on the public unsubscribe only — whatever
 * an `X-Forwarded-For` header claimed. Neither is proof; they are the
 * corroborating detail a consent challenge asks for alongside the timestamp,
 * and their value is that they are recorded at all.
 */
export interface ConsentEvidence {
  /** The subscriber's IP, as observed by whoever fronted the request. */
  ip?: string;
  userAgent?: string;
}

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
  /**
   * How many campaigns in a row have soft-bounced for this membership, with no
   * delivery in between (ADR-020). Reset to 0 by any successful delivery.
   *
   * Lives here rather than in `deliverability` because it is an observation
   * about *this* newsletter's sends. Escalating it to a global fact would be
   * inferring "the mailbox is dead everywhere" from one publication's evidence
   * — the over-reach ADR-018 exists to prevent.
   */
  consecutiveSoftBounces: number;
  /**
   * Where this membership's record came from, when it did not originate here
   * (ADR-022). Absent means cablegram collected the consent itself — the
   * subscribe/confirm path, first-hand evidence.
   *
   * It exists because an import restores a consent claim made to *another*
   * system, and without a marker that claim becomes indistinguishable from one
   * cablegram witnessed. If consent is ever challenged, "when did they opt in"
   * (`createdAt`) is only half the answer; "how do we know" is the other half.
   *
   * Deliberately **not** a merge field: merge fields are the template rendering
   * model, and provenance is metadata about the record rather than data about
   * the person — a `{{source}}` that can render into mail is a bug waiting to
   * happen. An opaque operator-supplied note; the domain never interprets it.
   */
  source?: string;
  /**
   * The consent record (ADR-023). Three moments, each with its own timestamp
   * and evidence, because each answers a different question and `updatedAt`
   * answers none of them — it means "when did this row last change", so the
   * first soft bounce after a confirmation used to erase when the confirmation
   * happened.
   *
   * `createdAt` is the signup moment's timestamp, so there is no `signupAt`;
   * duplicating it would give two fields that must agree forever.
   */
  signupIp?: string;
  signupUserAgent?: string;
  /**
   * When double opt-in was completed. Under GDPR this — not `createdAt` — is
   * the consent act: the signup is an assertion, the confirmation is the proof.
   * Absent on a single-opt-in row, because no confirmation ever happened.
   */
  confirmedAt?: Date;
  confirmedIp?: string;
  confirmedUserAgent?: string;
  /** When they opted out. CAN-SPAM gives 10 days to honour it; this proves you did. */
  unsubscribedAt?: Date;
  unsubscribedIp?: string;
  unsubscribedUserAgent?: string;
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
  /** Who submitted the signup, if the caller observed it (ADR-023). */
  evidence?: ConsentEvidence;
  now: Date;
}

/** Fields that may change when a lapsed row is revived (a re-subscribe). */
export interface ReviveSubscriptionProps {
  mergeFields?: MergeFields;
  tags?: string[];
  doubleOptIn: boolean;
  evidence?: ConsentEvidence;
  now: Date;
}

/**
 * Fields accepted when **importing** a membership (ADR-022).
 *
 * The difference from `CreateSubscriptionProps` is the whole point of the
 * distinction: an import is handed a `status` outright, where a subscribe
 * *derives* one from `doubleOptIn`. Migrating a list off another ESP means
 * restoring state that already exists — including people who unsubscribed,
 * bounced or complained — and no opt-in toggle can express those.
 */
export interface ImportSubscriptionProps {
  id: SubscriptionId;
  newsletterId: string;
  email: string;
  /** The restored lifecycle state, verbatim — never derived. */
  status: SubscriptionStatus;
  mergeFields?: MergeFields;
  tags?: string[];
  /**
   * The **original** opt-in date from the source system, when it is known. It
   * becomes `createdAt`, because that timestamp *is* the consent record — the
   * thing you most need if consent is ever challenged. Absent → `now`.
   */
  subscribedAt?: Date;
  /** Provenance note — where this record came from. Required for an import. */
  source: string;
  /**
   * The consent record as the source system recorded it (ADR-023). An ESP
   * export that carries opt-in IPs is carrying the most valuable thing in the
   * file after the addresses themselves; dropping it on import destroys
   * evidence that cannot be reconstructed afterwards.
   */
  consent?: ImportedConsentRecord;
  now: Date;
}

/** The consent trail an import may restore, all optional and all as-supplied. */
export interface ImportedConsentRecord {
  signupIp?: string;
  signupUserAgent?: string;
  confirmedAt?: Date;
  confirmedIp?: string;
  confirmedUserAgent?: string;
  unsubscribedAt?: Date;
  unsubscribedIp?: string;
  unsubscribedUserAgent?: string;
}

/** Fields an import overwrites on an existing row (`--on-conflict overwrite`). */
export interface OverwriteSubscriptionProps {
  status: SubscriptionStatus;
  mergeFields?: MergeFields;
  tags?: string[];
  subscribedAt?: Date;
  source: string;
  consent?: ImportedConsentRecord;
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
      consecutiveSoftBounces: 0,
      signupIp: input.evidence?.ip,
      signupUserAgent: input.evidence?.userAgent,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /**
   * Restore a membership from another system (ADR-022) — **not** a subscribe.
   *
   * `create` can only ever produce `pending` or `subscribed`, because it derives
   * the status from an opt-in toggle. That makes it structurally incapable of
   * expressing a migration, where the incoming data already contains people who
   * unsubscribed, hard-bounced or filed a spam complaint; importing those as
   * `subscribed` would mail people who explicitly opted out.
   *
   * So the status is supplied, not derived, and the original opt-in date is
   * preserved as `createdAt`. This factory deliberately has **no** notion of
   * double opt-in: an import must never trigger a confirmation email (the
   * caller has no new consent to confirm — it is restoring old consent).
   */
  static import(input: ImportSubscriptionProps): Subscription {
    const createdAt = input.subscribedAt ?? input.now;
    return new Subscription({
      id: input.id,
      newsletterId: input.newsletterId,
      email: validEmail(input.email),
      status: input.status,
      mergeFields: input.mergeFields ?? {},
      tags: normalizeTags(input.tags),
      consecutiveSoftBounces: 0,
      source: input.source,
      ...input.consent,
      createdAt,
      updatedAt: input.now,
    });
  }

  /**
   * Replace this membership with the imported one (`--on-conflict overwrite`,
   * ADR-022): the file is the source of truth, so every field it describes wins
   * — status included, opt-outs included.
   *
   * There is deliberately no partial/merge variant. A mode that is neither
   * "leave the row alone" nor "the file is the truth" has no one-sentence
   * description, which means nobody can predict afterwards what an import did
   * to their data. The conservative choice is the *default* (`skip`), not a
   * third blended behaviour.
   *
   * The soft-bounce streak resets: it is evidence gathered against the status
   * being replaced, so it cannot outlive it (same reasoning as `resubscribe`).
   */
  overwriteFromImport(input: OverwriteSubscriptionProps): void {
    this.props = {
      ...this.props,
      status: input.status,
      mergeFields: input.mergeFields ?? this.props.mergeFields,
      tags: input.tags === undefined ? this.props.tags : normalizeTags(input.tags),
      consecutiveSoftBounces: 0,
      source: input.source,
      // The whole consent trail is replaced, not merged: under `overwrite` the
      // file is the record, and a half-kept trail (this file's signup IP beside
      // the previous import's confirmation) would describe an event sequence
      // that never happened.
      signupIp: undefined,
      signupUserAgent: undefined,
      confirmedAt: undefined,
      confirmedIp: undefined,
      confirmedUserAgent: undefined,
      unsubscribedAt: undefined,
      unsubscribedIp: undefined,
      unsubscribedUserAgent: undefined,
      ...input.consent,
      createdAt: input.subscribedAt ?? this.props.createdAt,
      updatedAt: input.now,
    };
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
  confirm(now: Date, evidence?: ConsentEvidence): void {
    if (this.props.status === 'subscribed') return;
    if (this.props.status !== 'pending') {
      throw new SubscriptionStateError(`cannot confirm a ${this.props.status} subscription`);
    }
    this.props = {
      ...this.props,
      status: 'subscribed',
      // Recorded separately from `updatedAt` because this is the consent act
      // itself (ADR-023) — `updatedAt` moves again on the next soft bounce and
      // would take the answer with it.
      confirmedAt: now,
      confirmedIp: evidence?.ip,
      confirmedUserAgent: evidence?.userAgent,
      updatedAt: now,
    };
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
  /**
   * A campaign to this address soft-bounced (ADR-020).
   *
   * Postmark retries internally before reporting one, so a single soft bounce
   * already means a whole retry cycle failed — but it is still not proof the
   * mailbox is gone (a full inbox drains, a downed server comes back). So one
   * changes nothing; only repetition is a verdict.
   *
   * At `threshold` consecutive soft bounces the membership is marked `bounced`
   * for **this newsletter only**. It is deliberately *not* escalated to the
   * global suppression list: that would infer a mailbox-level fact from one
   * newsletter's evidence (ADR-018). Another newsletter mailing the same dead
   * address will reach the same conclusion from its own observations.
   *
   * Returns true when the streak crossed the threshold on this call.
   */
  recordSoftBounce(threshold: number, now: Date): boolean {
    // An already-lapsed membership has nothing left to escalate.
    if (this.props.status !== 'subscribed' && this.props.status !== 'pending') return false;

    const streak = this.props.consecutiveSoftBounces + 1;
    const escalate = streak >= threshold;
    this.props = {
      ...this.props,
      consecutiveSoftBounces: streak,
      status: escalate ? 'bounced' : this.props.status,
      updatedAt: now,
    };
    return escalate;
  }

  /**
   * Mail reached this address, so whatever was temporarily wrong is over — the
   * streak resets. Returns false when there was nothing to reset, which lets
   * the caller skip a pointless write on the overwhelmingly common path.
   */
  recordDelivery(now: Date): boolean {
    if (this.props.consecutiveSoftBounces === 0) return false;
    this.props = { ...this.props, consecutiveSoftBounces: 0, updatedAt: now };
    return true;
  }

  markComplained(now: Date): void {
    if (this.props.status === 'complained') return;
    this.props = { ...this.props, status: 'complained', updatedAt: now };
  }

  /**
   * Opt the subscriber out. Idempotent: unsubscribing twice is a no-op — and
   * that includes the evidence, so a repeated one-click POST cannot overwrite
   * when the opt-out actually happened. The first one is the one that counts.
   */
  unsubscribe(now: Date, evidence?: ConsentEvidence): void {
    if (this.props.status === 'unsubscribed') return;
    this.props = {
      ...this.props,
      status: 'unsubscribed',
      unsubscribedAt: now,
      unsubscribedIp: evidence?.ip,
      unsubscribedUserAgent: evidence?.userAgent,
      updatedAt: now,
    };
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
      // A fresh start: whatever was wrong with the mailbox before is not
      // evidence against the revived membership.
      consecutiveSoftBounces: 0,
      // A new signup, so a new consent record (ADR-023). The old trail is
      // cleared rather than kept: leaving a stale `unsubscribedAt` on an active
      // membership, or a `confirmedAt` from a confirmation that predates this
      // opt-in, would state something false. Under double opt-in `confirmedAt`
      // is filled in again by the confirm that follows; under single opt-in it
      // stays empty, because no confirmation ever happened.
      signupIp: input.evidence?.ip,
      signupUserAgent: input.evidence?.userAgent,
      confirmedAt: undefined,
      confirmedIp: undefined,
      confirmedUserAgent: undefined,
      unsubscribedAt: undefined,
      unsubscribedIp: undefined,
      unsubscribedUserAgent: undefined,
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
  get consecutiveSoftBounces(): number {
    return this.props.consecutiveSoftBounces;
  }
  /**
   * Where the record came from, or `undefined` when cablegram collected the
   * consent itself. A **historical** fact about the record's origin, so it is
   * left alone by every later transition — a re-subscribe through cablegram
   * changes the status and `updatedAt`, which is where "they since re-opted in"
   * is recorded; it does not rewrite where the row came from.
   */
  get source(): string | undefined {
    return this.props.source;
  }
  get signupIp(): string | undefined {
    return this.props.signupIp;
  }
  get signupUserAgent(): string | undefined {
    return this.props.signupUserAgent;
  }
  get confirmedAt(): Date | undefined {
    return this.props.confirmedAt;
  }
  get confirmedIp(): string | undefined {
    return this.props.confirmedIp;
  }
  get confirmedUserAgent(): string | undefined {
    return this.props.confirmedUserAgent;
  }
  get unsubscribedAt(): Date | undefined {
    return this.props.unsubscribedAt;
  }
  get unsubscribedIp(): string | undefined {
    return this.props.unsubscribedIp;
  }
  get unsubscribedUserAgent(): string | undefined {
    return this.props.unsubscribedUserAgent;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
