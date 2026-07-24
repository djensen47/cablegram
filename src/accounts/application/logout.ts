import { inject, injectable } from 'inversify';
import { hashOpaqueToken } from '../../shared/auth/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import type { RefreshTokenRepository } from './refresh-token-repository.js';
import type { LogoutInput } from './dtos.js';

/**
 * Revoke a session (ADR-013) by deleting the presented refresh token's stored
 * hash — the access token then simply expires on its own short TTL. Idempotent:
 * revoking an unknown or already-revoked token is a no-op, so logout always
 * succeeds.
 */
@injectable()
export class Logout {
  constructor(
    @inject(ACCOUNTS_TYPES.RefreshTokenRepository)
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  async execute(input: LogoutInput): Promise<void> {
    await this.refreshTokens.deleteByHash(hashOpaqueToken(input.refreshToken));
  }
}
