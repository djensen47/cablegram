import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { AUTH_TYPES, hashOpaqueToken, type AccessTokenService } from '../../shared/auth/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import { InvalidOneTimeTokenError } from '../domain/errors.js';
import type { UserRepository } from './user-repository.js';
import type { OneTimeTokenRepository } from './one-time-token-repository.js';
import type { RefreshTokenRepository } from './refresh-token-repository.js';
import { issueSession } from './login.js';
import type { ConsumeMagicLinkInput, SessionTokens } from './dtos.js';

/**
 * Complete a passwordless login (ADR-014): verify the emailed magic-link token by
 * hash and mint a session. An unknown, expired, already-used, or wrong-purpose
 * token is rejected as a single `InvalidOneTimeTokenError`. The token is consumed
 * (single-use) before the session is issued, and the session is minted through
 * the **same** `issueSession` helper login uses — so a magic-link session and a
 * password session are byte-for-byte the same shape.
 */
@injectable()
export class ConsumeMagicLink {
  constructor(
    @inject(ACCOUNTS_TYPES.OneTimeTokenRepository)
    private readonly tokens: OneTimeTokenRepository,
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.RefreshTokenRepository)
    private readonly refreshTokens: RefreshTokenRepository,
    @inject(AUTH_TYPES.AccessTokenService) private readonly accessTokens: AccessTokenService,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: ConsumeMagicLinkInput): Promise<SessionTokens> {
    const tokenHash = hashOpaqueToken(input.token);
    const stored = await this.tokens.findByHash(tokenHash);
    if (stored === null || stored.purpose !== 'magic-link') {
      throw new InvalidOneTimeTokenError();
    }
    if (stored.expiresAt.getTime() <= this.clock.now().getTime()) {
      await this.tokens.deleteByHash(tokenHash);
      throw new InvalidOneTimeTokenError();
    }
    const user = await this.users.findById(stored.userId);
    if (user === null) {
      await this.tokens.deleteByHash(tokenHash);
      throw new InvalidOneTimeTokenError();
    }

    // Consume the token before minting the session (single-use).
    await this.tokens.deleteByHash(tokenHash);
    return issueSession(this.accessTokens, this.refreshTokens, this.config, this.clock, user);
  }
}
