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
import type { RequestMagicLinkInput } from './dtos.js';

/**
 * Begin a passwordless (magic-link) login (ADR-014). Always resolves without
 * error and the route always returns 200, whether or not the address has an
 * account — **non-enumerating**, exactly like the password-reset request. When a
 * user exists we mint an opaque one-time token (hash stored, scoped `magic-link`,
 * short TTL) and email it via the system sender; otherwise nothing is sent.
 */
@injectable()
export class RequestMagicLink {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.OneTimeTokenRepository)
    private readonly tokens: OneTimeTokenRepository,
    @inject(ACCOUNTS_TYPES.AccountMailer) private readonly mailer: AccountMailer,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: RequestMagicLinkInput): Promise<void> {
    const user = await this.users.findByEmail(normalizeEmailAddress(input.email));
    if (user === null) return;

    const token = newOpaqueToken();
    const now = this.clock.now();
    await this.tokens.create({
      tokenHash: hashOpaqueToken(token),
      userId: user.id,
      purpose: 'magic-link',
      expiresAt: new Date(now.getTime() + this.config.oneTimeTokens.magicLinkTtlSeconds * 1000),
      createdAt: now,
    });
    await this.mailer.sendMagicLink(user.email, token);
  }
}
