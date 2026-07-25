/**
 * The seam every command talks through (ADR-016). Commands never call `fetch`
 * and never see a `Response`: they name a method, a path under `/v1`, and
 * optionally a body, and get back a parsed JSON value or an `ApiError`.
 *
 * Keeping this an interface in `application/` is what lets the command tests run
 * with a stub client — no network, no server — the same way the server's route
 * tests rebind repositories to in-memory doubles (ADR-003).
 */
export interface ApiRequest {
  /** Path under the API root, e.g. `/v1/newsletters`. */
  path: string;
  /** Query parameters; `undefined` values are omitted rather than sent empty. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * When true, the request is sent without an `Authorization` header and no
   * refresh is attempted on 401 — for the open endpoints (setup, login,
   * refresh, logout, the password-reset and magic-link flows).
   */
  anonymous?: boolean;
  /**
   * Opt-in `Idempotency-Key` (the API honors it on mutating POSTs). Used for
   * the one operation where a retried request would be expensive: sending.
   */
  idempotencyKey?: string;
}

/** The cursor-paginated list envelope every `/v1` list route returns. */
export interface ListEnvelope<T> {
  data: T[];
  meta: { nextCursor: string | null };
}

export interface ApiClient {
  get<T>(path: string, query?: ApiRequest['query']): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Partial<ApiRequest>): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  /** DELETE returns 204 with no body, so it resolves to void. */
  delete(path: string): Promise<void>;
  /**
   * Follows `meta.nextCursor` until exhausted, concatenating pages. Used by
   * `--all` on list commands and by anything that needs a complete set (the
   * recipient count shown before a send, for example).
   */
  listAll<T>(path: string, query?: ApiRequest['query']): Promise<T[]>;
  /** The deployment this client is pointed at, for messages and `config show`. */
  baseUrl(): string;
}
