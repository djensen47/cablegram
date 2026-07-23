import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { InvalidUserEmailError } from './errors.js';

// Conservative address check — the same shape used everywhere an address is
// accepted at the boundary (deliverability, subscriptions); ADR-013 reuses it
// for the account email so identity is consistent.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The role taxonomy (ADR-013). A closed, extensible set: `admin` manages users
 * and everything; `manager` manages newsletters/campaigns but not users.
 */
export const ROLES = ['admin', 'manager'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Fully-resolved user state; the shape a repository reconstitutes from. */
export interface UserProps {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a user (the password is pre-hashed by the use case). */
export interface CreateUserProps {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  now: Date;
}

/**
 * The user account aggregate (ADR-013): an operator of the single-tenant
 * instance — not a tenant, not a subscriber. The email is the human-facing
 * identity, normalized via the shared `email-address` module so it always
 * matches the unique index and the login lookup. Password hashing is an
 * infrastructure concern (async, KDF-based): the domain only ever holds the
 * already-computed `passwordHash`, never a plaintext password.
 *
 * The "first user is admin" invariant is a use-case concern
 * (`RegisterInitialAdmin`), not the aggregate's — a `User` simply carries
 * whatever role it was created with.
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage), so
 * an instance is always valid.
 */
export class User {
  private constructor(private props: UserProps) {}

  static create(input: CreateUserProps): User {
    const email = normalizeEmailAddress(input.email);
    if (!EMAIL_RE.test(email)) {
      throw new InvalidUserEmailError(input.email);
    }
    return new User({
      id: input.id,
      email,
      passwordHash: input.passwordHash,
      role: input.role,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: UserProps): User {
    return new User(props);
  }

  /** Replace the stored password hash (e.g. a future change-password flow). */
  changePassword(passwordHash: string, now: Date): void {
    this.props = { ...this.props, passwordHash, updatedAt: now };
  }

  get id(): string {
    return this.props.id;
  }
  get email(): string {
    return this.props.email;
  }
  get passwordHash(): string {
    return this.props.passwordHash;
  }
  get role(): Role {
    return this.props.role;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
