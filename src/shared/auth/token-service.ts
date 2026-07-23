/**
 * The access-token seam (ADR-013). A cross-cutting shared concern — both
 * `accounts` (which issues tokens on login/refresh) and `shared/http`'s
 * `jwtAuth` middleware (which verifies them) depend on this interface, so it
 * lives in a shared leaf rather than inside a domain component. The `role`
 * claim is an opaque string here; `accounts` owns the role vocabulary.
 */
export interface AccessClaims {
  userId: string;
  role: string;
}

export interface AccessTokenService {
  /** Issue a signed, short-lived access token carrying the caller's identity + role. */
  issueAccessToken(claims: AccessClaims): Promise<string>;
  /**
   * Verify a token's signature and expiry and return its claims. Rejects
   * (throws) on any invalid, mis-signed, or expired token — callers map the
   * rejection to a 401.
   */
  verifyAccessToken(token: string): Promise<AccessClaims>;
}
