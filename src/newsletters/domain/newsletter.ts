import type { Id } from '../../shared/ids/index.js';
import { InvalidEmailAddressError, InvalidNewsletterError } from './errors.js';

/**
 * A newsletter's identity. A light alias over the app-owned string `Id`
 * (ADR-012) — a plain `_id`, never a Mongo `ObjectId` — for compile-time intent
 * at call sites. Not a nominal brand; still assignable to/from `string`.
 */
export type NewsletterId = Id;

// Deliberately conservative address check: exactly one `@`, non-empty local and
// domain parts, a dot in the domain, no whitespace. Real deliverability is
// Postmark's job (ADR-008); this only rejects obvious garbage at the boundary.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const DKIM_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;
// A provider's own identifier, so the shape is deliberately loose: Postmark
// documents no ID rules for message streams. Only obvious garbage is refused.
const CHANNEL_RE = /^\S{1,100}$/;

/**
 * A validated, normalized email address value object. Stored and compared in
 * lowercase so sender identities are stable regardless of input casing.
 */
export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(raw: string): EmailAddress {
    const normalized = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) {
      throw new InvalidEmailAddressError(raw);
    }
    return new EmailAddress(normalized);
  }

  equals(other: EmailAddress): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

/** Fully-resolved newsletter state; the shape a repository reconstitutes from. */
export interface NewsletterProps {
  id: NewsletterId;
  name: string;
  fromName: string;
  fromEmail: EmailAddress;
  replyTo: EmailAddress | null;
  sendingDomain: string | null;
  dkimIdentifier: string | null;
  /**
   * The provider channel this newsletter's **campaigns** go through (ADR-030;
   * named `sendingChannel` until ADR-031) — for Postmark, the ID of a
   * Broadcasts-type message stream, chosen by the operator. Named for the role,
   * not the vendor (ADR-008).
   *
   * `null` only on a newsletter stored before the field existed: it reads back
   * normally, but cannot send a campaign until one is set.
   */
  campaignChannel: string | null;
  /**
   * The provider channel this newsletter's **subscription confirmations** go
   * through (ADR-031) — for Postmark, the ID of a Transactional-type stream.
   * Kept apart from `campaignChannel` because Postmark suppresses per stream:
   * on the campaign stream, someone who once unsubscribed could never receive
   * the confirmation for a re-signup.
   *
   * `null` on a newsletter created before ADR-031: double opt-in signups to it
   * are refused until one is set; single opt-in sends no mail and is unaffected.
   */
  confirmationChannel: string | null;
  /**
   * Whether a signup to this newsletter must be confirmed by email before it
   * counts (ADR-032). `false` — single opt-in — is the default, including for a
   * newsletter stored before the field existed. A signup request may still
   * override it either way.
   */
  doubleOptIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a newsletter (primitives at the boundary). */
export interface CreateNewsletterProps {
  id: NewsletterId;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  sendingDomain?: string | null;
  dkimIdentifier?: string | null;
  /** Required: there is no default channel to fall back on (ADR-030). */
  campaignChannel: string;
  /** Required, for the same reason (ADR-031). */
  confirmationChannel: string;
  /** Defaults to `false` — single opt-in (ADR-032). */
  doubleOptIn?: boolean;
  now: Date;
}

/** Fields that may be changed on an existing newsletter; omitted = unchanged. */
export interface UpdateNewsletterProps {
  name?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string | null;
  sendingDomain?: string | null;
  dkimIdentifier?: string | null;
  /** May be changed, never cleared — a newsletter without one cannot send. */
  campaignChannel?: string;
  /** May be changed, never cleared (ADR-031). */
  confirmationChannel?: string;
  doubleOptIn?: boolean;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidNewsletterError(field, 'must not be empty');
  }
  return trimmed;
}

// Optional identifiers normalize empty/whitespace to `null` and validate shape.
function optionalDomain(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!DOMAIN_RE.test(trimmed)) {
    throw new InvalidNewsletterError('sendingDomain', 'must be a valid domain name');
  }
  return trimmed;
}

function requireChannel(field: 'campaignChannel' | 'confirmationChannel', value: string): string {
  const trimmed = value.trim();
  if (!CHANNEL_RE.test(trimmed)) {
    throw new InvalidNewsletterError(field, 'must be 1-100 characters with no whitespace');
  }
  return trimmed;
}

function optionalDkim(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!DKIM_RE.test(trimmed)) {
    throw new InvalidNewsletterError('dkimIdentifier', 'must be a valid DKIM selector');
  }
  return trimmed;
}

/**
 * The newsletter aggregate: the publication itself plus its sender identity
 * (from-name/email, reply-to) and sending-domain/DKIM identity (ADR-011).
 * Constructed only through `create` (new) or `reconstitute` (from storage), so
 * an instance is always valid.
 */
export class Newsletter {
  private constructor(private props: NewsletterProps) {}

  static create(input: CreateNewsletterProps): Newsletter {
    return new Newsletter({
      id: input.id,
      name: requireText(input.name, 'name'),
      fromName: requireText(input.fromName, 'fromName'),
      fromEmail: EmailAddress.create(input.fromEmail),
      replyTo: input.replyTo != null && input.replyTo.trim() !== ''
        ? EmailAddress.create(input.replyTo)
        : null,
      sendingDomain: optionalDomain(input.sendingDomain),
      dkimIdentifier: optionalDkim(input.dkimIdentifier),
      campaignChannel: requireChannel('campaignChannel', input.campaignChannel),
      confirmationChannel: requireChannel('confirmationChannel', input.confirmationChannel),
      doubleOptIn: input.doubleOptIn ?? false,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: NewsletterProps): Newsletter {
    return new Newsletter(props);
  }

  /** Apply a partial change set, re-validating touched fields and bumping `updatedAt`. */
  update(changes: UpdateNewsletterProps, now: Date): void {
    const next: NewsletterProps = { ...this.props };

    if (changes.name !== undefined) next.name = requireText(changes.name, 'name');
    if (changes.fromName !== undefined) next.fromName = requireText(changes.fromName, 'fromName');
    if (changes.fromEmail !== undefined) next.fromEmail = EmailAddress.create(changes.fromEmail);
    if (changes.replyTo !== undefined) {
      next.replyTo =
        changes.replyTo != null && changes.replyTo.trim() !== ''
          ? EmailAddress.create(changes.replyTo)
          : null;
    }
    if (changes.sendingDomain !== undefined) next.sendingDomain = optionalDomain(changes.sendingDomain);
    if (changes.dkimIdentifier !== undefined) next.dkimIdentifier = optionalDkim(changes.dkimIdentifier);
    if (changes.campaignChannel !== undefined) {
      next.campaignChannel = requireChannel('campaignChannel', changes.campaignChannel);
    }
    if (changes.confirmationChannel !== undefined) {
      next.confirmationChannel = requireChannel('confirmationChannel', changes.confirmationChannel);
    }
    if (changes.doubleOptIn !== undefined) next.doubleOptIn = changes.doubleOptIn;

    next.updatedAt = now;
    this.props = next;
  }

  get id(): NewsletterId {
    return this.props.id;
  }
  get name(): string {
    return this.props.name;
  }
  get fromName(): string {
    return this.props.fromName;
  }
  get fromEmail(): EmailAddress {
    return this.props.fromEmail;
  }
  get replyTo(): EmailAddress | null {
    return this.props.replyTo;
  }
  get sendingDomain(): string | null {
    return this.props.sendingDomain;
  }
  get dkimIdentifier(): string | null {
    return this.props.dkimIdentifier;
  }
  get campaignChannel(): string | null {
    return this.props.campaignChannel;
  }
  get confirmationChannel(): string | null {
    return this.props.confirmationChannel;
  }
  get doubleOptIn(): boolean {
    return this.props.doubleOptIn;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
