/**
 * The password KDF seam (ADR-013). The interface lives with its consumers (the
 * accounts use cases) per ADR-001; the production implementation is argon2id
 * via `@node-rs/argon2` (`infrastructure/`), and tests rebind it to a fast fake
 * so login/create flows stay deterministic and quick without exercising the KDF.
 */
export interface PasswordHasher {
  /** Hash a plaintext password into a self-describing, storable digest. */
  hash(plain: string): Promise<string>;
  /** Constant-time-ish verify of a plaintext against a stored digest. */
  verify(hash: string, plain: string): Promise<boolean>;
}
