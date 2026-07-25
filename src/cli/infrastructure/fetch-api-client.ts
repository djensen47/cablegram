import type { ApiClient, ApiRequest, ListEnvelope } from '../application/api-client.js';
import { ApiError, transportError } from '../application/api-error.js';
import type { CredentialStore, StoredCredentials } from '../application/credential-store.js';
import {
  credentialsFromSession,
  isAccessTokenExpired,
  type SessionResponse,
} from '../application/session.js';

/**
 * The `ApiClient` over Node's global `fetch` (ADR-016 §4 — no HTTP dependency).
 *
 * Two behaviors justify this class existing rather than commands calling `fetch`
 * directly:
 *
 * 1. **Transparent refresh.** Access tokens are short-lived (15m by default,
 *    ADR-013), so an operator would otherwise re-login constantly. On a 401 —
 *    or pre-emptively, when the stored expiry has passed — the client exchanges
 *    the refresh token, persists the **rotated** pair, and retries the original
 *    request once. Exactly once: a second 401 is a real authentication failure
 *    and must surface, not loop.
 * 2. **One error type.** Every failure path — non-2xx, unparseable body,
 *    connection refused — becomes an `ApiError`, so no command ever handles a
 *    raw `fetch` rejection.
 */
export class FetchApiClient implements ApiClient {
  /**
   * Guards against concurrent refreshes. Two in-flight requests that both 401
   * would otherwise each spend the refresh token; since refresh **rotates** the
   * token (ADR-013), the second exchange would present an already-consumed
   * token and fail. Sharing the in-flight promise means one exchange, two
   * retries.
   */
  private refreshInFlight: Promise<StoredCredentials> | null = null;

  constructor(
    private readonly credentials: StoredCredentials,
    private readonly store: CredentialStore,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  baseUrl(): string {
    return this.credentials.baseUrl;
  }

  get<T>(path: string, query?: ApiRequest['query']): Promise<T> {
    return this.request<T>('GET', { path, query });
  }

  post<T>(path: string, body?: unknown, options: Partial<ApiRequest> = {}): Promise<T> {
    return this.request<T>('POST', { ...options, path, body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', { path, body });
  }

  async delete(path: string): Promise<void> {
    await this.request<unknown>('DELETE', { path });
  }

  /**
   * Walks `meta.nextCursor` to the end. The page size is pinned to the API's
   * maximum so a large list costs the fewest possible round trips.
   */
  async listAll<T>(path: string, query: ApiRequest['query'] = {}): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.get<ListEnvelope<T>>(path, { ...query, limit: 100, cursor });
      all.push(...page.data);
      cursor = page.meta.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return all;
  }

  /**
   * Whether this client is able to refresh at all. A token supplied directly
   * via `CABLEGRAM_TOKEN` arrives without a refresh token (and without an
   * expiry), and is documented as used-as-is: attempting to refresh it would
   * fail with a misleading "not logged in" instead of letting the server give
   * the real answer.
   */
  private get canRefresh(): boolean {
    return this.credentials.refreshToken !== undefined;
  }

  private async request<T>(method: string, req: ApiRequest): Promise<T> {
    const refreshable = req.anonymous !== true && this.canRefresh;

    // Pre-emptive refresh: if the stored token is already past its expiry there
    // is no point spending a round trip to be told so.
    if (refreshable && isAccessTokenExpired(this.credentials, this.now())) {
      await this.refresh();
    }

    const response = await this.send(method, req);

    if (response.status === 401 && refreshable) {
      await this.refresh();
      const retried = await this.send(method, req);
      return this.toResult<T>(retried);
    }

    return this.toResult<T>(response);
  }

  private async send(method: string, req: ApiRequest): Promise<Response> {
    const url = new URL(req.path, this.credentials.baseUrl);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.anonymous !== true && this.credentials.accessToken !== undefined) {
      headers.authorization = `Bearer ${this.credentials.accessToken}`;
    }
    if (req.idempotencyKey !== undefined) headers['idempotency-key'] = req.idempotencyKey;

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
    } catch (cause) {
      throw transportError(this.credentials.baseUrl, cause);
    }
  }

  /** Parses a response into its value, or throws the `ApiError` it describes. */
  private async toResult<T>(response: Response): Promise<T> {
    // 204 (delete, logout, password-reset confirm) carries no body at all.
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      // A non-JSON body from a proxy or gateway — surface the status, not a
      // parse error, since the parse failure is not the operator's problem.
      if (!response.ok) {
        throw new ApiError(
          `${response.status} ${response.statusText}`,
          response.status,
          'unexpected_response',
        );
      }
      return undefined as T;
    }

    if (!response.ok) {
      throw ApiError.fromBody(response.status, body, `${response.status} ${response.statusText}`);
    }
    return body as T;
  }

  /**
   * Exchanges the refresh token for a new session and persists the rotated
   * pair. Mutates `this.credentials` in place so every subsequent request on
   * this client (and the retry immediately following) uses the new token.
   */
  private async refresh(): Promise<StoredCredentials> {
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<StoredCredentials> {
    const { refreshToken } = this.credentials;
    if (refreshToken === undefined) {
      throw new ApiError('Not logged in — run `cablegram login`.', 401, 'not_logged_in');
    }

    const response = await this.send('POST', {
      path: '/v1/auth/refresh',
      body: { refreshToken },
      anonymous: true,
    });

    if (!response.ok) {
      // The refresh token is expired or was revoked (a password reset revokes
      // every session, ADR-013). Drop it: keeping a dead token only produces a
      // confusing second failure on the next command.
      await this.store.save({ baseUrl: this.credentials.baseUrl });
      throw new ApiError(
        'Your session has expired — run `cablegram login` again.',
        401,
        'session_expired',
      );
    }

    const session = (await response.json()) as SessionResponse;
    const refreshed = credentialsFromSession(this.credentials.baseUrl, session, this.now());
    Object.assign(this.credentials, refreshed);
    await this.store.save(refreshed);
    return refreshed;
  }
}
