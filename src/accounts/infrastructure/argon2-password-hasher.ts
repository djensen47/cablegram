import { injectable } from 'inversify';
import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/password-hasher.js';

/**
 * The production `PasswordHasher` (ADR-013): argon2id via `@node-rs/argon2`
 * (prebuilt binaries — no compiler needed at install). `@node-rs/argon2`
 * defaults to the **argon2id** variant, so `hash` needs no options (the
 * `Algorithm` enum is an ambient const enum, unusable under `isolatedModules`);
 * a unit test pins the `$argon2id$` digest so a library default change can't
 * silently downgrade it. The digest is self-describing (algorithm, version, and
 * parameters are embedded), so `verify` needs no external configuration.
 */
@injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      // A malformed/foreign digest is a verification failure, not an error.
      return false;
    }
  }
}
