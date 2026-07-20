/**
 * Subscription domain errors. Pure — they carry no HTTP status or framework
 * type (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004). Each is a distinct class so the mapping is a `switch`, not string
 * matching.
 */
export abstract class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A supplied email address is not a valid, normalizable address. */
export class InvalidSubscriptionEmailError extends SubscriptionError {
  constructor(readonly input: string) {
    super(`Invalid email address: ${JSON.stringify(input)}`);
  }
}

/** A subscription field violates an invariant (empty tag, malformed merge field, …). */
export class InvalidSubscriptionError extends SubscriptionError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid subscription ${field}: ${reason}`);
  }
}

/** No subscription exists for the given id (within the addressed newsletter). */
export class SubscriptionNotFoundError extends SubscriptionError {
  constructor(readonly id: string) {
    super(`Subscription not found: ${id}`);
  }
}

/**
 * The newsletter a subscribe request targets does not exist. Distinct from
 * `SubscriptionNotFoundError` so the edge can map the missing *newsletter* to a
 * 404 with a message that points at the newsletter, not the subscription.
 */
export class SubscriptionNewsletterNotFoundError extends SubscriptionError {
  constructor(readonly newsletterId: string) {
    super(`Newsletter not found: ${newsletterId}`);
  }
}

/** A requested state transition is not legal for the subscription's current status. */
export class SubscriptionStateError extends SubscriptionError {
  constructor(reason: string) {
    super(`Invalid subscription state transition: ${reason}`);
  }
}
