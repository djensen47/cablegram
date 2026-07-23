import { SignJWT, jwtVerify } from 'jose';
import { inject, injectable } from 'inversify';
import { TYPES } from '../di/index.js';
import type { AppConfig } from '../config/index.js';
import type { Clock } from '../clock/index.js';
import type { AccessClaims, AccessTokenService } from './token-service.js';

/**
 * `jose`-backed access tokens (ADR-013): HS256, signed with the configured
 * `JWT_SECRET`. `sub` carries the user id and a `role` claim the role. The
 * issue-time timestamp comes from the injected `Clock` (so token lifetimes are
 * deterministic under test); `jose` enforces `exp` on verify against the real
 * clock. This is the one place the JWT wire format is pinned — treat it, not
 * memory, as the source of truth.
 */
@injectable()
export class JoseAccessTokenService implements AccessTokenService {
  private readonly secret: Uint8Array;
  private readonly accessTtlSeconds: number;

  constructor(
    @inject(TYPES.Config) config: AppConfig,
    @inject(TYPES.Clock) private readonly clock: Clock,
  ) {
    this.secret = new TextEncoder().encode(config.jwt.secret);
    this.accessTtlSeconds = config.jwt.accessTtlSeconds;
  }

  async issueAccessToken(claims: AccessClaims): Promise<string> {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + this.accessTtlSeconds)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] });
    const userId = payload.sub;
    const role = payload.role;
    if (typeof userId !== 'string' || typeof role !== 'string') {
      throw new Error('Access token is missing required claims');
    }
    return { userId, role };
  }
}
