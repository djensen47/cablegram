/**
 * Newsletter domain errors. Pure — they carry no HTTP status or framework type
 * (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004). Each is a distinct class so the mapping is a `switch`, not string
 * matching.
 */
export abstract class NewsletterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A supplied email address is not a valid address. */
export class InvalidEmailAddressError extends NewsletterError {
  constructor(readonly input: string) {
    super(`Invalid email address: ${JSON.stringify(input)}`);
  }
}

/** A newsletter field violates an invariant (empty name, malformed domain, …). */
export class InvalidNewsletterError extends NewsletterError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid newsletter ${field}: ${reason}`);
  }
}

/** No newsletter exists for the given id. */
export class NewsletterNotFoundError extends NewsletterError {
  constructor(readonly id: string) {
    super(`Newsletter not found: ${id}`);
  }
}
