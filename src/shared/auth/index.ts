// Facade for the auth module (ADR-002/005): import only from here. A true
// `shared/*` leaf — the JWT signing/verifying seam plus the generic opaque-token
// helpers (refresh tokens, reset + magic-link tokens), imported by no domain component.
export { AUTH_TYPES } from './types.js';
export { authModule } from './module.js';
export type { AccessClaims, AccessTokenService } from './token-service.js';
export { JoseAccessTokenService } from './jose-access-token-service.js';
export { newOpaqueToken, hashOpaqueToken } from './opaque-token.js';
