/**
 * Accounts domain errors. Pure — they carry no HTTP status or framework type
 * (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004). Each is a distinct class so the mapping is a `switch`, not string
 * matching.
 */
export abstract class AccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A supplied email address is not a valid, normalizable address. */
export class InvalidUserEmailError extends AccountsError {
  constructor(readonly input: string) {
    super(`Invalid email address: ${JSON.stringify(input)}`);
  }
}

/** No user exists for the given id. */
export class UserNotFoundError extends AccountsError {
  constructor(readonly id: string) {
    super(`User not found: ${id}`);
  }
}

/** A user already exists with the given email — accounts are one-per-address. */
export class EmailAlreadyExistsError extends AccountsError {
  constructor(readonly email: string) {
    super(`A user already exists with email: ${email}`);
  }
}

/** Login was attempted with an unknown email or a wrong password. */
export class InvalidCredentialsError extends AccountsError {
  constructor() {
    // Deliberately does not say which of email/password was wrong.
    super('Invalid email or password');
  }
}

/** The presented refresh token is unknown, expired, or already rotated away. */
export class InvalidRefreshTokenError extends AccountsError {
  constructor() {
    super('Invalid or expired refresh token');
  }
}

/**
 * First-run setup was attempted after a user already exists. Setup is a
 * one-time bootstrap (ADR-013); thereafter user creation is admin-only.
 */
export class SetupAlreadyCompletedError extends AccountsError {
  constructor() {
    super('Setup has already been completed');
  }
}
