import { injectable } from 'inversify';
import type {
  RefreshTokenRepository,
  StoredRefreshToken,
} from '../application/refresh-token-repository.js';

/**
 * A real in-memory `RefreshTokenRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). Keyed by token hash, mirroring the Mongo repository's
 * contract so login/refresh/logout tests exercise the same behavior.
 */
@injectable()
export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private readonly byHash = new Map<string, StoredRefreshToken>();

  async create(token: StoredRefreshToken): Promise<void> {
    this.byHash.set(token.tokenHash, token);
  }

  async findByHash(tokenHash: string): Promise<StoredRefreshToken | null> {
    return this.byHash.get(tokenHash) ?? null;
  }

  async deleteByHash(tokenHash: string): Promise<boolean> {
    return this.byHash.delete(tokenHash);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    let deleted = 0;
    for (const [hash, token] of this.byHash) {
      if (token.userId === userId) {
        this.byHash.delete(hash);
        deleted += 1;
      }
    }
    return deleted;
  }
}
