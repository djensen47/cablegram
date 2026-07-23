/**
 * DI tokens for the `auth` shared module (ADR-003). The composition root binds
 * `AccessTokenService`; the app assembly resolves it to hand to `jwtAuth`, and
 * the accounts use cases inject it to issue tokens. Tests can rebind it.
 */
export const AUTH_TYPES = {
  AccessTokenService: Symbol.for('AccessTokenService'),
} as const;
