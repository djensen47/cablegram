/**
 * Template domain errors. Pure — they carry no HTTP status or framework type
 * (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004). Each is a distinct class so the mapping is a `switch`, not string
 * matching.
 */
export abstract class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A template field violates an invariant (empty name, empty body, …). */
export class InvalidTemplateError extends TemplateError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid template ${field}: ${reason}`);
  }
}

/** No template exists for the given id. */
export class TemplateNotFoundError extends TemplateError {
  constructor(readonly id: string) {
    super(`Template not found: ${id}`);
  }
}

/**
 * A template's `bodyHtml`/`bodyText` source failed to compile against the
 * bound engine (malformed syntax). Raised by the renderer (infrastructure)
 * but surfaced through this pure domain error type so `presentation/` can map
 * it the same way as any other template error, without importing the engine.
 */
export class TemplateCompileError extends TemplateError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Template ${field} failed to compile: ${reason}`);
  }
}
