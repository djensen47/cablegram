/**
 * Errors raised by the email gateway. A shared technical leaf carries no HTTP
 * or domain semantics (ADR-001/005); the presentation layer that drives a send
 * decides how to surface a provider failure.
 *
 * The two classes answer the one question a caller has to ask before it
 * retries (ADR-035): **could the provider have the submission?**
 *
 *  - {@link EmailDeliveryError} — unknown. The request may have reached the
 *    provider: the connection dropped, the call timed out, the provider
 *    answered 5xx, or it answered 200 with a body this adapter could not read.
 *    Retrying may send the same mail twice.
 *  - {@link EmailRejectedError} — no. The provider answered and refused, so
 *    nothing in the submission was accepted and a retry cannot duplicate it.
 *
 * Unknown is the base class on purpose: a failure nobody classified must be
 * treated as the unsafe case.
 */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    /** The provider HTTP status, when the failure came from an HTTP response. */
    readonly status?: number,
    /** The provider error code, when one was returned in the body. */
    readonly providerErrorCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The provider refused the submission outright: nothing was accepted. */
export class EmailRejectedError extends EmailDeliveryError {}
