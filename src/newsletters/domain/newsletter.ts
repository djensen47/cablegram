import type { Id } from '../../shared/ids/index.js';
import { InvalidEmailAddressError, InvalidNewsletterError } from './errors.js';

/**
 * A newsletter's identity. A light alias over the app-owned string `Id`
 * (ADR-007) — a plain `_id`, never a Mongo `ObjectId` — for compile-time intent
 * at call sites. Not a nominal brand; still assignable to/from `string`.
 */
export type NewsletterId = Id;

// Deliberately conservative address check: exactly one `@`, non-empty local and
// domain parts, a dot in the domain, no whitespace. Real deliverability is
// Postmark's job (ADR-008); this only rejects obvious garbage at the boundary.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const DKIM_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

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
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
