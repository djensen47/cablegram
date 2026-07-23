import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { AUTH_TYPES, hashRefreshToken, type AccessTokenService } from '../../shared/auth/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import { InvalidRefreshTokenError } from '../domain/errors.js';
import type { UserRepository } from './user-repository.js';
import type { RefreshTokenRepository } from './refresh-token-repository.js';
import { issueSession } from './login.js';
import type { RefreshInput, SessionTokens } from './dtos.js';

/**
 * Exchange a valid refresh token for a fresh session (ADR-013), **rotating** it:
 * the presented token is single-use — it is deleted and a new refresh token is
 * issued alongside a new access token. An unknown, expired, or already-rotated
 * token is rejected as `InvalidRefreshTokenError`; an expired or orphaned token
 * is also deleted so it cannot be probed again.
 */
@injectable()
export class RefreshSession {
  constructor(
    @inject(ACCOUNTS_TYPES.RefreshTokenRepository)
    private readonly refreshTokens: RefreshTokenRepository,
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(AUTH_TYPES.AccessTokenService) private readonly tokens: AccessTokenService,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: RefreshInput): Promise<SessionTokens> {
    const tokenHash = hashRefreshToken(input.refreshToken);
    const stored = await this.refreshTokens.findByHash(tokenHash);
    if (stored === null) {
      throw new InvalidRefreshTokenError();
    }
    if (stored.expiresAt.getTime() <= this.clock.now().getTime()) {
      await this.refreshTokens.deleteByHash(tokenHash);
      throw new InvalidRefreshTokenError();
    }
    const user = await this.users.findById(stored.userId);
    if (user === null) {
      await this.refreshTokens.deleteByHash(tokenHash);
      throw new InvalidRefreshTokenError();
    }
    // Rotate: the presented token is consumed before a new session is minted.
    await this.refreshTokens.deleteByHash(tokenHash);
    return issueSession(this.tokens, this.refreshTokens, this.config, this.clock, user);
  }
}
