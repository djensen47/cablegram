import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { InvalidSuppressedAddressError } from './errors.js';

// Deliberately conservative check — same shape as `newsletters`' `EmailAddress`
// (ADR-011: no shared `Contact` identity, but the *validation* shape is
// consistent everywhere an address is accepted at the boundary).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The suppression reason taxonomy (ADR-011). A closed set — not a free-text
 * field — so every caller and every list filter agrees on the vocabulary.
 */
export const SUPPRESSION_REASONS = [
  'hard-bounce',
  'spam-complaint',
  'manual-junk',
  'global-opt-out',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function isSuppressionReason(value: string): value is SuppressionReason {
  return (SUPPRESSION_REASONS as readonly string[]).includes(value);
}

/** Fully-resolved suppression entry; the shape a repository reconstitutes from. */
export interface SuppressionEntryProps {
  address: string;
  reason: SuppressionReason;
  createdAt: Date;
}

/** Fields accepted when adding a suppression entry (primitives at the boundary). */
export interface AddSuppressionProps {
  address: string;
  reason: SuppressionReason;
  now: Date;
}

/**
 * The suppression-list entry aggregate (ADR-011): a global, address-keyed
 * deny-list row cablegram must never send to. The **address itself is the
 * identity** — normalized via the shared `email-address` module so it always
 * matches the keys `subscriptions` uses for the same address (no separate
 * surrogate id; a suppression is inherently one-row-per-address).
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage), so
 * an instance is always valid.
 */
export class SuppressionEntry {
  private constructor(private props: SuppressionEntryProps) {}

  static create(input: AddSuppressionProps): SuppressionEntry {
    const normalized = normalizeEmailAddress(input.address);
    if (!EMAIL_RE.test(normalized)) {
      throw new InvalidSuppressedAddressError(input.address);
    }
    return new SuppressionEntry({
      address: normalized,
      reason: input.reason,
      createdAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: SuppressionEntryProps): SuppressionEntry {
    return new SuppressionEntry(props);
  }

  get address(): string {
    return this.props.address;
  }
  get reason(): SuppressionReason {
    return this.props.reason;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
}
