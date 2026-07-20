/**
 * Deliverability domain errors. Pure — no HTTP status or framework type
 * (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004).
 */
export abstract class DeliverabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A supplied address is not a valid, normalizable email address. */
export class InvalidSuppressedAddressError extends DeliverabilityError {
  constructor(readonly input: string) {
    super(`Invalid email address: ${JSON.stringify(input)}`);
  }
}

/** No suppression entry exists for the given address. */
export class SuppressionNotFoundError extends DeliverabilityError {
  constructor(readonly address: string) {
    super(`Suppression not found: ${address}`);
  }
}
