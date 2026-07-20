/**
 * Errors raised by the email gateway. A shared technical leaf carries no HTTP
 * or domain semantics (ADR-001/005); the presentation layer that drives a send
 * decides how to surface a provider failure.
 */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    /** The provider HTTP status, when the failure came from an HTTP response. */
    readonly status?: number,
    /** The provider error code, when one was returned in the body. */
    readonly providerErrorCode?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
