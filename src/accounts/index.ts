// Facade for the accounts component (ADR-002/005): import only from here.
// Everything below is the component's public surface; internals are reached
// only through these exports.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { accountsModule } from './infrastructure/module.js';
export { ACCOUNTS_TYPES } from './types.js';

// HTTP routers (mounted onto /v1 by the app assembly).
export { createAccountsAuthRoutes } from './presentation/auth-routes.js';
export { createUserRoutes } from './presentation/user-routes.js';

// Test doubles: the DI-rebind seams (ADR-003).
export { InMemoryUserRepository } from './infrastructure/in-memory-user-repository.js';
export { InMemoryRefreshTokenRepository } from './infrastructure/in-memory-refresh-token-repository.js';
export { InMemoryOneTimeTokenRepository } from './infrastructure/in-memory-one-time-token-repository.js';
export { FakePasswordHasher } from './infrastructure/fake-password-hasher.js';

// Domain + application contracts consumers may need to type against.
export { User, ROLES, isRole, type Role } from './domain/user.js';
export {
  AccountsError,
  InvalidUserEmailError,
  UserNotFoundError,
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  InvalidOneTimeTokenError,
  SetupAlreadyCompletedError,
} from './domain/errors.js';
export type { UserRepository, ListUsersOptions } from './application/user-repository.js';
export type {
  RefreshTokenRepository,
  StoredRefreshToken,
} from './application/refresh-token-repository.js';
export type {
  OneTimeTokenRepository,
  OneTimeTokenPurpose,
  StoredOneTimeToken,
} from './application/one-time-token-repository.js';
export type { PasswordHasher } from './application/password-hasher.js';
export { AccountMailer } from './application/account-mailer.js';
export type { SessionTokens } from './application/dtos.js';

// Use case classes (resolved from the container by token; typed here for tests).
export { RegisterInitialAdmin } from './application/register-initial-admin.js';
export { CreateUser } from './application/create-user.js';
export { Login } from './application/login.js';
export { RefreshSession } from './application/refresh-session.js';
export { Logout } from './application/logout.js';
export { RequestPasswordReset } from './application/request-password-reset.js';
export { ResetPassword } from './application/reset-password.js';
export { RequestMagicLink } from './application/request-magic-link.js';
export { ConsumeMagicLink } from './application/consume-magic-link.js';
export { ListUsers } from './application/list-users.js';
export { GetUser } from './application/get-user.js';
