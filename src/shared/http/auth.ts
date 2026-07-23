import { createMiddleware } from 'hono/factory';
import type { AccessTokenService } from '../auth/index.js';
import type { AppEnv } from './app-env.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';

/**
 * JWT bearer auth for `/v1` (ADR-013). Reads `Authorization: Bearer <token>`,
 * verifies the HS256 access token through the injected `AccessTokenService`,
 * and sets the authenticated `{ userId, role }` on the Hono context for
 * downstream handlers and role guards. There is no API-key fallback — a valid
 * user JWT is the only accepted `/v1` credential (the Postmark webhook, mounted
 * outside `/v1`, keeps its own Basic-Auth).
 */
export function jwtAuth(tokens: AccessTokenService) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization');
    if (header === undefined || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedError();
    }
    const token = header.slice('bearer '.length).trim();

    let claims;
    try {
      claims = await tokens.verifyAccessToken(token);
    } catch {
      // A malformed, mis-signed, or expired token is indistinguishable to the
      // caller — all are simply "not authenticated".
      throw new UnauthorizedError('Invalid or expired token');
    }

    c.set('auth', { userId: claims.userId, role: claims.role });
    await next();
  });
}

/**
 * Role guard (ADR-013). Mount **after** `jwtAuth` on a route/router that only a
 * given role may reach (e.g. `admin` for `/v1/users`). A missing auth context
 * is a 401 (the guard was mounted without `jwtAuth` ahead of it, or the token
 * was absent); a present-but-wrong role is a 403.
 */
export function requireRole(role: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (auth === undefined) {
      throw new UnauthorizedError();
    }
    if (auth.role !== role) {
      throw new ForbiddenError(`Requires the ${role} role`);
    }
    await next();
  });
}
