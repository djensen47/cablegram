/**
 * The CLI-side representation of a failed API call (ADR-016). The server renders
 * every error through one envelope (`shared/http`'s `onError`):
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "details": ?, "requestId": ? } }
 * ```
 *
 * `ApiError` is that envelope, plus the status, carried as a throwable. It is
 * deliberately the *only* error type the command layer has to reason about:
 * transport failures are wrapped too, so a command never sees a raw `TypeError`
 * from `fetch`.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * True when the request never reached the API (DNS, refused, TLS, timeout).
   *
   * Keyed on the code rather than `status === 0`, because other locally-raised
   * errors also have no HTTP status and must not be reported as "could not
   * reach the server" — that would send someone debugging their network over a
   * mistyped flag.
   */
  get isTransport(): boolean {
    return this.code === 'transport_error';
  }

  /**
   * Builds an `ApiError` from a response body, tolerating bodies that are not
   * the standard envelope — an upstream proxy or load balancer can return HTML
   * or plain text, and the CLI must still produce a sensible message rather
   * than crash while reporting a crash.
   */
  static fromBody(status: number, body: unknown, fallback: string): ApiError {
    const envelope = (body as { error?: unknown } | null)?.error;
    if (envelope !== null && typeof envelope === 'object') {
      const { code, message, details, requestId } = envelope as Record<string, unknown>;
      return new ApiError(
        typeof message === 'string' && message.length > 0 ? message : fallback,
        status,
        typeof code === 'string' ? code : 'unknown_error',
        details,
        typeof requestId === 'string' ? requestId : undefined,
      );
    }
    return new ApiError(fallback, status, 'unknown_error');
  }
}

/** A transport-level failure: the request never got an HTTP response. */
export function transportError(baseUrl: string, cause: unknown): ApiError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new ApiError(`Could not reach ${baseUrl}: ${reason}`, 0, 'transport_error');
}
