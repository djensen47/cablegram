import { ContainerModule } from 'inversify';
import { AUTH_TYPES } from './types.js';
import type { AccessTokenService } from './token-service.js';
import { JoseAccessTokenService } from './jose-access-token-service.js';

/**
 * The auth module's DI wiring (ADR-003), loaded by the composition root. Binds
 * the `jose`-backed access-token service; tests may rebind
 * `AUTH_TYPES.AccessTokenService`. Still a `shared/*` leaf — it imports no
 * domain component.
 */
export const authModule = new ContainerModule((bind) => {
  bind<AccessTokenService>(AUTH_TYPES.AccessTokenService).to(JoseAccessTokenService);
});
