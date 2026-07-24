import { inject, injectable } from 'inversify';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import type { Clock } from '../../shared/clock/index.js';
import {
  AUTH_TYPES,
  hashOpaqueToken,
  newOpaqueToken,
  type AccessTokenService,
} from '../../shared/auth/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import { InvalidCredentialsError } from '../domain/errors.js';
import type { User } from '../domain/user.js';
import type { UserRepository } from './user-repository.js';
import { DUMMY_PASSWORD_DIGEST, type PasswordHasher } from './password-hasher.js';
import type { RefreshTokenRepository } from './refresh-token-repository.js';
import type { LoginInput, SessionTokens } from './dtos.js';

/**
 * Authenticate email + password and mint a session (ADR-013): a short-lived
 * access JWT plus an opaque refresh token whose hash is persisted so it can be
 * revoked. An unknown email and a wrong password both yield the same
 * `InvalidCredentialsError`, so the response never reveals which failed.
 */
@injectable()
export class Login {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(ACCOUNTS_TYPES.RefreshTokenRepository)
    private readonly refreshTokens: RefreshTokenRepository,
    @inject(AUTH_TYPES.AccessTokenService) private readonly tokens: AccessTokenService,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: LoginInput): Promise<SessionTokens> {
    const user = await this.users.findByEmail(normalizeEmailAddress(input.email));
    // Run a verify on BOTH paths so an unknown email and a wrong password take
    // equivalent time — otherwise the KDF cost only paid on the known-email path
    // is a user-enumeration timing oracle (ADR-013). The unknown-email path
    // verifies against a fixed dummy digest that no credential can satisfy.
    const ok = await this.hasher.verify(user?.passwordHash ?? DUMMY_PASSWORD_DIGEST, input.password);
    if (user === null || !ok) {
      throw new InvalidCredentialsError();
    }
    return issueSession(this.tokens, this.refreshTokens, this.config, this.clock, user);
  }
}

/**
 * Issue an access token + a rotated refresh token for a user and persist the
 * refresh token's hash. Shared by `Login` and `RefreshSession` so the two mint
 * sessions identically.
 */
export async function issueSession(
  tokens: AccessTokenService,
  refreshTokens: RefreshTokenRepository,
  config: AppConfig,
  clock: Clock,
  user: User,
): Promise<SessionTokens> {
  const accessToken = await tokens.issueAccessToken({ userId: user.id, role: user.role });
  const refreshToken = newOpaqueToken();
  const now = clock.now();
  await refreshTokens.create({
    tokenHash: hashOpaqueToken(refreshToken),
    userId: user.id,
    expiresAt: new Date(now.getTime() + config.jwt.refreshTtlSeconds * 1000),
    createdAt: now,
  });
  return { accessToken, refreshToken, expiresInSeconds: config.jwt.accessTtlSeconds };
}
