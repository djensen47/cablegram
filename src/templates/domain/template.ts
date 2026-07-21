import type { Id } from '../../shared/ids/index.js';
import { InvalidTemplateError } from './errors.js';

/**
 * A template's identity. A light alias over the app-owned string `Id`
 * (ADR-012) — a plain `_id`, never a Mongo `ObjectId` — for compile-time intent
 * at call sites. Not a nominal brand; still assignable to/from `string`.
 */
export type TemplateId = Id;

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidTemplateError(field, 'must not be empty');
  }
  return trimmed;
}

// `bodyText` normalizes empty/whitespace-only input to `null` (no explicit
// text body — the renderer derives one from `bodyHtml`, see `TemplateRenderer`).
function optionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim().length === 0 ? null : value;
}

/** Fully-resolved template state; the shape a repository reconstitutes from. */
export interface TemplateProps {
  id: TemplateId;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a template (primitives at the boundary). */
export interface CreateTemplateProps {
  id: TemplateId;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string | null;
  now: Date;
}

/** Fields that may be changed on an existing template; omitted = unchanged. */
export interface UpdateTemplateProps {
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string | null;
}

/**
 * The template aggregate: a reusable, named message shape — subject plus an
 * HTML body and an optional text body (ADR-011). Template source (`bodyHtml`/
 * `bodyText`) is untrusted merge-field markup for the bound `TemplateRenderer`
 * (application/), not executable code — the domain itself only checks
 * non-emptiness; syntax validity is an engine concern (infrastructure/).
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage), so
 * an instance is always valid.
 */
export class Template {
  private constructor(private props: TemplateProps) {}

  static create(input: CreateTemplateProps): Template {
    return new Template({
      id: input.id,
      name: requireText(input.name, 'name'),
      subject: requireText(input.subject, 'subject'),
      bodyHtml: requireText(input.bodyHtml, 'bodyHtml'),
      bodyText: optionalText(input.bodyText),
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: TemplateProps): Template {
    return new Template(props);
  }

  /** Apply a partial change set, re-validating touched fields and bumping `updatedAt`. */
  update(changes: UpdateTemplateProps, now: Date): void {
    const next: TemplateProps = { ...this.props };

    if (changes.name !== undefined) next.name = requireText(changes.name, 'name');
    if (changes.subject !== undefined) next.subject = requireText(changes.subject, 'subject');
    if (changes.bodyHtml !== undefined) next.bodyHtml = requireText(changes.bodyHtml, 'bodyHtml');
    if (changes.bodyText !== undefined) next.bodyText = optionalText(changes.bodyText);

    next.updatedAt = now;
    this.props = next;
  }

  get id(): TemplateId {
    return this.props.id;
  }
  get name(): string {
    return this.props.name;
  }
  get subject(): string {
    return this.props.subject;
  }
  get bodyHtml(): string {
    return this.props.bodyHtml;
  }
  get bodyText(): string | null {
    return this.props.bodyText;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
