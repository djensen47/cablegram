import { injectable } from 'inversify';
import type { PasswordHasher } from '../application/password-hasher.js';

/**
 * A deterministic, fast `PasswordHasher` for tests (ADR-013) — the DI-rebind
 * double for `Argon2PasswordHasher`. It does **no** real KDF work (so it must
 * never be wired in production), just a reversible prefix, which keeps login /
 * create-user tests quick and their assertions obvious.
 */
@injectable()
export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `fake:${plain}`;
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    return digest === `fake:${plain}`;
  }
}
