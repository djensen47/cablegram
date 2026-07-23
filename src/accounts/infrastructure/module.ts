import { ContainerModule } from 'inversify';
import { ACCOUNTS_TYPES } from '../types.js';
import type { UserRepository } from '../application/user-repository.js';
import type { RefreshTokenRepository } from '../application/refresh-token-repository.js';
import type { PasswordHasher } from '../application/password-hasher.js';
import { RegisterInitialAdmin } from '../application/register-initial-admin.js';
import { CreateUser } from '../application/create-user.js';
import { Login } from '../application/login.js';
import { RefreshSession } from '../application/refresh-session.js';
import { Logout } from '../application/logout.js';
import { ListUsers } from '../application/list-users.js';
import { GetUser } from '../application/get-user.js';
import { MongoUserRepository } from './mongo-user-repository.js';
import { MongoRefreshTokenRepository } from './mongo-refresh-token-repository.js';
import { Argon2PasswordHasher } from './argon2-password-hasher.js';

/**
 * The accounts component's DI wiring (ADR-003). Loaded by the composition root;
 * the canonical repositories are Mongo-backed and the hasher is argon2id here,
 * and tests rebind `UserRepository`/`RefreshTokenRepository` to their in-memory
 * doubles and `PasswordHasher` to `FakePasswordHasher`. Interfaces only are
 * injected — never a concrete class.
 */
export const accountsModule = new ContainerModule((bind) => {
  bind<UserRepository>(ACCOUNTS_TYPES.UserRepository).to(MongoUserRepository);
  bind<RefreshTokenRepository>(ACCOUNTS_TYPES.RefreshTokenRepository).to(
    MongoRefreshTokenRepository,
  );
  bind<PasswordHasher>(ACCOUNTS_TYPES.PasswordHasher).to(Argon2PasswordHasher);

  bind<RegisterInitialAdmin>(ACCOUNTS_TYPES.RegisterInitialAdmin).to(RegisterInitialAdmin);
  bind<CreateUser>(ACCOUNTS_TYPES.CreateUser).to(CreateUser);
  bind<Login>(ACCOUNTS_TYPES.Login).to(Login);
  bind<RefreshSession>(ACCOUNTS_TYPES.RefreshSession).to(RefreshSession);
  bind<Logout>(ACCOUNTS_TYPES.Logout).to(Logout);
  bind<ListUsers>(ACCOUNTS_TYPES.ListUsers).to(ListUsers);
  bind<GetUser>(ACCOUNTS_TYPES.GetUser).to(GetUser);
});
