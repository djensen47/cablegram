import { inject, injectable } from 'inversify';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { hashOpaqueToken, newOpaqueToken } from '../../shared/auth/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import type { UserRepository } from './user-repository.js';
import type { OneTimeTokenRepository } from './one-time-token-repository.js';
import { AccountMailer } from './account-mailer.js';
import type { RequestPasswordResetInput } from './dtos.js';

/**
 * Begin a password reset (ADR-013). Always resolves without error and the route
 * always returns 200, whether or not the address has an account — so the endpoint
 * is **non-enumerating**. When a user exists we mint an opaque one-time token
 * (only its hash stored, scoped `password-reset`, short TTL) and email it via the
 * system sender; when none does, nothing is sent. The response never differs.
 */
@injectable()
export class RequestPasswordReset {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.OneTimeTokenRepository)
    private readonly tokens: OneTimeTokenRepository,
    @inject(ACCOUNTS_TYPES.AccountMailer) private readonly mailer: AccountMailer,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: RequestPasswordResetInput): Promise<void> {
    const user = await this.users.findByEmail(normalizeEmailAddress(input.email));
    if (user === null) return;

    const token = newOpaqueToken();
    const now = this.clock.now();
    await this.tokens.create({
      tokenHash: hashOpaqueToken(token),
      userId: user.id,
      purpose: 'password-reset',
      expiresAt: new Date(now.getTime() + this.config.oneTimeTokens.passwordResetTtlSeconds * 1000),
      createdAt: now,
    });
    await this.mailer.sendPasswordReset(user.email, token);
  }
}
