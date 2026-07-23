// Facade for the auth module (ADR-002/005): import only from here. A true
// `shared/*` leaf — the JWT signing/verifying seam plus the opaque
// refresh-token helpers, imported by no domain component.
export { AUTH_TYPES } from './types.js';
export { authModule } from './module.js';
export type { AccessClaims, AccessTokenService } from './token-service.js';
export { JoseAccessTokenService } from './jose-access-token-service.js';
export { newRefreshToken, hashRefreshToken } from './refresh-token.js';
