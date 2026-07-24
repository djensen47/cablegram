import { injectable } from 'inversify';
import type {
  OneTimeTokenRepository,
  StoredOneTimeToken,
} from '../application/one-time-token-repository.js';

/**
 * A real in-memory `OneTimeTokenRepository` (not a mock) — the DI-rebind test
 * seam (ADR-003). Keyed by token hash, mirroring the Mongo repository's contract
 * so the password-reset / magic-link use-case tests exercise the same behavior.
 */
@injectable()
export class InMemoryOneTimeTokenRepository implements OneTimeTokenRepository {
  private readonly byHash = new Map<string, StoredOneTimeToken>();

  async create(token: StoredOneTimeToken): Promise<void> {
    this.byHash.set(token.tokenHash, token);
  }

  async findByHash(tokenHash: string): Promise<StoredOneTimeToken | null> {
    return this.byHash.get(tokenHash) ?? null;
  }

  async deleteByHash(tokenHash: string): Promise<boolean> {
    return this.byHash.delete(tokenHash);
  }
}
