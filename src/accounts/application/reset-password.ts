import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { hashOpaqueToken } from '../../shared/auth/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import { InvalidOneTimeTokenError } from '../domain/errors.js';
import type { UserRepository } from './user-repository.js';
import type { OneTimeTokenRepository } from './one-time-token-repository.js';
import type { RefreshTokenRepository } from './refresh-token-repository.js';
import type { PasswordHasher } from './password-hasher.js';
import type { ResetPasswordInput } from './dtos.js';

/**
 * Complete a password reset (ADR-013). Verifies the emailed one-time token by
 * hash (never stored raw), rejecting an unknown, expired, already-used, or
 * wrong-purpose token as a single `InvalidOneTimeTokenError`. On success the
 * token is consumed (single-use), the user's password hash is replaced, and
 * **all** their existing sessions are revoked (`deleteAllForUser`) so a reset
 * — the recovery path after a possible compromise — cannot leave stale sessions
 * alive.
 */
@injectable()
export class ResetPassword {
  constructor(
    @inject(ACCOUNTS_TYPES.OneTimeTokenRepository)
    private readonly tokens: OneTimeTokenRepository,
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.RefreshTokenRepository)
    private readonly refreshTokens: RefreshTokenRepository,
    @inject(ACCOUNTS_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: ResetPasswordInput): Promise<void> {
    const tokenHash = hashOpaqueToken(input.token);
    const stored = await this.tokens.findByHash(tokenHash);
    // Unknown token, or a token minted for a different flow — reject without
    // consuming it (deleting a valid magic-link token here would be an oracle).
    if (stored === null || stored.purpose !== 'password-reset') {
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

    // Consume the token before applying the change (single-use).
    await this.tokens.deleteByHash(tokenHash);
    user.changePassword(await this.hasher.hash(input.newPassword), this.clock.now());
    await this.users.update(user);
    // A credential change logs out every existing session.
    await this.refreshTokens.deleteAllForUser(user.id);
  }
}
