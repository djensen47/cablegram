/**
 * The stored CLI session (ADR-016). Mirrors the `Session` DTO the API returns
 * from `POST /v1/auth/login` — with `expiresIn` (a duration) resolved into
 * `accessTokenExpiresAt` (an absolute ISO instant), because a duration is only
 * meaningful at the moment it is issued and this is read minutes or days later.
 */
export interface StoredCredentials {
  /** Base URL of the cablegram deployment, e.g. `https://api.example.com`. */
  baseUrl: string;
  accessToken?: string;
  /** ISO-8601 instant at which `accessToken` expires. */
  accessTokenExpiresAt?: string;
  /**
   * The opaque refresh token (ADR-013). Rotated on every refresh, so this is
   * rewritten whenever the client refreshes — a stale copy is already revoked.
   */
  refreshToken?: string;
}

/**
 * Where the CLI keeps its session between invocations. An interface in
 * `application/` with the file-backed implementation reaching in from
 * `infrastructure/` (ADR-001): the command layer depends on this seam, so tests
 * substitute an in-memory store and never touch the operator's real config.
 */
export interface CredentialStore {
  load(): Promise<StoredCredentials | null>;
  save(credentials: StoredCredentials): Promise<void>;
  /** Removes the stored session. Idempotent: clearing an absent session succeeds. */
  clear(): Promise<void>;
  /** Human-readable location, for `config show` and error messages. */
  location(): string;
}
