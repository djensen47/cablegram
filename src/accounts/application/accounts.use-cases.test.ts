import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { AUTH_TYPES, type AccessTokenService } from '../../shared/auth/index.js';
import { TEST_ENV } from '../../shared/testing/index.js';
import {
  ACCOUNTS_TYPES,
  InMemoryUserRepository,
  InMemoryRefreshTokenRepository,
  FakePasswordHasher,
  RegisterInitialAdmin,
  CreateUser,
  Login,
  RefreshSession,
  Logout,
  ListUsers,
  GetUser,
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  SetupAlreadyCompletedError,
  UserNotFoundError,
} from '../index.js';

// Rebind the repositories to in-memory doubles and the hasher to the fast fake
// (ADR-003); the access-token service stays the real `jose` wiring (DB-free).
function testContainer(): Container {
  const container = buildContainer(TEST_ENV);
  container.rebind(ACCOUNTS_TYPES.UserRepository).to(InMemoryUserRepository);
  container.rebind(ACCOUNTS_TYPES.RefreshTokenRepository).to(InMemoryRefreshTokenRepository);
  container.rebind(ACCOUNTS_TYPES.PasswordHasher).to(FakePasswordHasher);
  return container;
}

describe('accounts use cases', () => {
  let container: Container;

  const setup = () => container.get<RegisterInitialAdmin>(ACCOUNTS_TYPES.RegisterInitialAdmin);
  const createUser = () => container.get<CreateUser>(ACCOUNTS_TYPES.CreateUser);
  const login = () => container.get<Login>(ACCOUNTS_TYPES.Login);
  const refresh = () => container.get<RefreshSession>(ACCOUNTS_TYPES.RefreshSession);
  const logout = () => container.get<Logout>(ACCOUNTS_TYPES.Logout);

  beforeEach(() => {
    container = testContainer();
  });

  describe('first-run setup', () => {
    it('makes the first user an admin', async () => {
      const admin = await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
      expect(admin.role).toBe('admin');
      expect(admin.email).toBe('boss@dispatch.example');
      // The password is run through the hasher, not stored as-is.
      expect(admin.passwordHash).not.toBe('hunter2!!');
    });

    it('409s once any user exists', async () => {
      await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
      await expect(
        setup().execute({ email: 'second@dispatch.example', password: 'another!!' }),
      ).rejects.toBeInstanceOf(SetupAlreadyCompletedError);
    });
  });

  describe('create user', () => {
    beforeEach(async () => {
      await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
    });

    it('creates a manager with the requested role', async () => {
      const user = await createUser().execute({
        email: 'ed@dispatch.example',
        password: 'editor-pw!',
        role: 'manager',
      });
      expect(user.role).toBe('manager');
    });

    it('rejects a duplicate email (case/space-insensitive)', async () => {
      await createUser().execute({ email: 'ed@dispatch.example', password: 'editor-pw!', role: 'manager' });
      await expect(
        createUser().execute({ email: '  ED@Dispatch.Example ', password: 'x-pw-yz!', role: 'admin' }),
      ).rejects.toBeInstanceOf(EmailAlreadyExistsError);
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
    });

    it('returns a verifiable access token + a refresh token on success', async () => {
      const session = await login().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
      expect(session.refreshToken).toBeTruthy();
      expect(session.expiresInSeconds).toBe(900);

      const claims = await container
        .get<AccessTokenService>(AUTH_TYPES.AccessTokenService)
        .verifyAccessToken(session.accessToken);
      expect(claims.role).toBe('admin');
    });

    it('accepts a differently-cased email', async () => {
      const session = await login().execute({ email: 'BOSS@dispatch.example', password: 'hunter2!!' });
      expect(session.accessToken).toBeTruthy();
    });

    it('rejects a wrong password', async () => {
      await expect(
        login().execute({ email: 'boss@dispatch.example', password: 'nope' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('rejects an unknown email (same error as a wrong password)', async () => {
      await expect(
        login().execute({ email: 'ghost@dispatch.example', password: 'hunter2!!' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  });

  describe('refresh + logout', () => {
    beforeEach(async () => {
      await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
    });

    it('rotates the refresh token: the old one is single-use', async () => {
      const first = await login().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
      const rotated = await refresh().execute({ refreshToken: first.refreshToken });
      expect(rotated.refreshToken).not.toBe(first.refreshToken);

      // The consumed token can't be replayed.
      await expect(
        refresh().execute({ refreshToken: first.refreshToken }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
      // The new one works.
      const again = await refresh().execute({ refreshToken: rotated.refreshToken });
      expect(again.accessToken).toBeTruthy();
    });

    it('rejects an unknown refresh token', async () => {
      await expect(
        refresh().execute({ refreshToken: 'never-issued' }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    });

    it('logout revokes the refresh token (and is idempotent)', async () => {
      const session = await login().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
      await logout().execute({ refreshToken: session.refreshToken });
      await expect(
        refresh().execute({ refreshToken: session.refreshToken }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
      // Revoking again does not throw.
      await expect(logout().execute({ refreshToken: session.refreshToken })).resolves.toBeUndefined();
    });
  });

  describe('list + get users', () => {
    it('lists with a limit+1 sentinel and gets by id', async () => {
      const admin = await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
      await createUser().execute({ email: 'a@dispatch.example', password: 'a-pw-123!', role: 'manager' });
      await createUser().execute({ email: 'b@dispatch.example', password: 'b-pw-123!', role: 'manager' });

      const rows = await container.get<ListUsers>(ACCOUNTS_TYPES.ListUsers).execute({ limit: 2 });
      // limit + 1 fetched so the caller can detect a next page.
      expect(rows).toHaveLength(3);

      const got = await container.get<GetUser>(ACCOUNTS_TYPES.GetUser).execute(admin.id);
      expect(got.email).toBe('boss@dispatch.example');

      await expect(
        container.get<GetUser>(ACCOUNTS_TYPES.GetUser).execute('missing'),
      ).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });
});
