/**
 * DI tokens for the accounts component (ADR-003). A pure-Symbol leaf every
 * layer of this component may import; concrete bindings live in the
 * `ContainerModule` (infrastructure), and tests rebind the repository +
 * password-hasher tokens to in-memory / fake doubles.
 */
export const ACCOUNTS_TYPES = {
  UserRepository: Symbol.for('UserRepository'),
  RefreshTokenRepository: Symbol.for('RefreshTokenRepository'),
  PasswordHasher: Symbol.for('PasswordHasher'),
  RegisterInitialAdmin: Symbol.for('RegisterInitialAdmin'),
  CreateUser: Symbol.for('CreateUser'),
  Login: Symbol.for('Login'),
  RefreshSession: Symbol.for('RefreshSession'),
  Logout: Symbol.for('Logout'),
  ListUsers: Symbol.for('ListUsers'),
  GetUser: Symbol.for('GetUser'),
} as const;
