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

/**
 * A fixed, valid argon2id digest used to blunt the login user-enumeration timing
 * oracle (ADR-013): when no user matches the supplied email, `Login` still runs a
 * `verify` against this digest so the unknown-email path pays the same KDF cost
 * as a wrong-password path, then throws the identical `InvalidCredentialsError`.
 * It is a real `$argon2id$` digest (of a throwaway secret) so `Argon2PasswordHasher`
 * does genuine work; it is never a valid credential for any account. Kept beside
 * the `PasswordHasher` seam so the constant travels with the interface it serves.
 */
export const DUMMY_PASSWORD_DIGEST =
  '$argon2id$v=19$m=19456,t=2,p=1$Gv8qDEAMrqIJuoGqN/hncg$phO/9Q/Pjp4EbxydrlA9jh3y3wCGn3zlRP5LJHnLKdg';
