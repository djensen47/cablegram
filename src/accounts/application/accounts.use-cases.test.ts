import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { AUTH_TYPES, type AccessTokenService } from '../../shared/auth/index.js';
import { EMAIL_TYPES, InMemoryDeliveryGateway } from '../../shared/email/index.js';
import { TEST_ENV } from '../../shared/testing/index.js';
import {
  ACCOUNTS_TYPES,
  InMemoryUserRepository,
  InMemoryRefreshTokenRepository,
  InMemoryOneTimeTokenRepository,
  FakePasswordHasher,
  RegisterInitialAdmin,
  CreateUser,
  Login,
  RefreshSession,
  Logout,
  RequestPasswordReset,
  ResetPassword,
  RequestMagicLink,
  ConsumeMagicLink,
  ListUsers,
  GetUser,
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidOneTimeTokenError,
  InvalidRefreshTokenError,
  SetupAlreadyCompletedError,
  UserNotFoundError,
  type PasswordHasher,
} from '../index.js';

// Rebind the repositories to in-memory doubles, the hasher to the fast fake, and
// the email gateway to the in-memory double (ADR-003) so account-mail flows can
// be inspected; the access-token service stays the real `jose` wiring (DB-free).
function testContainer(): Container {
  const container = buildContainer(TEST_ENV);
  container.rebind(ACCOUNTS_TYPES.UserRepository).to(InMemoryUserRepository);
  container.rebind(ACCOUNTS_TYPES.RefreshTokenRepository).to(InMemoryRefreshTokenRepository);
  container.rebind(ACCOUNTS_TYPES.OneTimeTokenRepository).to(InMemoryOneTimeTokenRepository);
  container.rebind(ACCOUNTS_TYPES.PasswordHasher).to(FakePasswordHasher);
  container.rebind(EMAIL_TYPES.DeliveryGateway).to(InMemoryDeliveryGateway);
  return container;
}

/** The opaque one-time token is 32 random bytes as base64url — exactly 43 chars. */
function tokenFromLastEmail(gateway: InMemoryDeliveryGateway): string {
  const last = gateway.sent.at(-1);
  const match = /([A-Za-z0-9_-]{43})/.exec(last?.content.textBody ?? '');
  if (match === null) throw new Error('no one-time token found in the sent email');
  return match[1]!;
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

    it('exercises the hasher even for an unknown email (no timing enumeration oracle)', async () => {
      // The verify runs on BOTH paths so an unknown email and a wrong password
      // take equivalent work — otherwise the KDF cost is a user-enumeration
      // side-channel (ADR-013). Prove the unknown-email path still verifies.
      const hasher = container.get<PasswordHasher>(ACCOUNTS_TYPES.PasswordHasher);
      const spy = vi.spyOn(hasher, 'verify');

      await expect(
        login().execute({ email: 'ghost@dispatch.example', password: 'hunter2!!' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      expect(spy).toHaveBeenCalledTimes(1);
      // It verified against the dummy digest, not any real user's hash.
      expect(spy.mock.calls[0]![0]).toMatch(/^\$argon2id\$/);
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

  describe('password reset', () => {
    const requestReset = () =>
      container.get<RequestPasswordReset>(ACCOUNTS_TYPES.RequestPasswordReset);
    const resetPassword = () => container.get<ResetPassword>(ACCOUNTS_TYPES.ResetPassword);
    const gateway = () =>
      container.get<InMemoryDeliveryGateway>(EMAIL_TYPES.DeliveryGateway);

    beforeEach(async () => {
      await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
    });

    it('emails a transactional reset token from the system sender', async () => {
      await requestReset().execute({ email: 'boss@dispatch.example' });

      expect(gateway().sent).toHaveLength(1);
      const msg = gateway().sent[0]!;
      expect(msg.category).toBe('transactional');
      expect(msg.from.fromEmail).toBe('system@cablegram.example');
      expect(msg.recipients).toEqual([{ email: 'boss@dispatch.example' }]);
      // The opaque token rides in the body (only its hash is stored).
      expect(tokenFromLastEmail(gateway())).toBeTruthy();
    });

    it('is non-enumerating: an unknown address succeeds but sends nothing', async () => {
      await expect(
        requestReset().execute({ email: 'ghost@dispatch.example' }),
      ).resolves.toBeUndefined();
      expect(gateway().sent).toHaveLength(0);
    });

    it('sets the new password, is single-use, and revokes existing sessions', async () => {
      // Open a session first, so we can prove reset revokes it.
      const oldSession = await login().execute({
        email: 'boss@dispatch.example',
        password: 'hunter2!!',
      });

      await requestReset().execute({ email: 'boss@dispatch.example' });
      const token = tokenFromLastEmail(gateway());

      await resetPassword().execute({ token, newPassword: 'brand-new-pw!' });

      // Old password no longer works; the new one does.
      await expect(
        login().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      const fresh = await login().execute({
        email: 'boss@dispatch.example',
        password: 'brand-new-pw!',
      });
      expect(fresh.accessToken).toBeTruthy();

      // Pre-reset session was revoked.
      await expect(
        refresh().execute({ refreshToken: oldSession.refreshToken }),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenError);

      // The reset token cannot be replayed.
      await expect(
        resetPassword().execute({ token, newPassword: 'another-pw!' }),
      ).rejects.toBeInstanceOf(InvalidOneTimeTokenError);
    });

    it('rejects an unknown token', async () => {
      await expect(
        resetPassword().execute({ token: 'never-issued', newPassword: 'brand-new-pw!' }),
      ).rejects.toBeInstanceOf(InvalidOneTimeTokenError);
    });

    it('rejects an expired token', async () => {
      // Reset TTL is 1h by default; advance the clock past it.
      await requestReset().execute({ email: 'boss@dispatch.example' });
      const token = tokenFromLastEmail(gateway());
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 3_600_001));
      try {
        await expect(
          resetPassword().execute({ token, newPassword: 'brand-new-pw!' }),
        ).rejects.toBeInstanceOf(InvalidOneTimeTokenError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a magic-link token presented to the reset endpoint (wrong purpose)', async () => {
      await container
        .get<RequestMagicLink>(ACCOUNTS_TYPES.RequestMagicLink)
        .execute({ email: 'boss@dispatch.example' });
      const magicToken = tokenFromLastEmail(gateway());
      await expect(
        resetPassword().execute({ token: magicToken, newPassword: 'brand-new-pw!' }),
      ).rejects.toBeInstanceOf(InvalidOneTimeTokenError);
    });
  });

  describe('magic-link login', () => {
    const requestLink = () => container.get<RequestMagicLink>(ACCOUNTS_TYPES.RequestMagicLink);
    const consumeLink = () => container.get<ConsumeMagicLink>(ACCOUNTS_TYPES.ConsumeMagicLink);
    const gateway = () =>
      container.get<InMemoryDeliveryGateway>(EMAIL_TYPES.DeliveryGateway);

    beforeEach(async () => {
      await setup().execute({ email: 'boss@dispatch.example', password: 'hunter2!!' });
    });

    it('is non-enumerating: an unknown address succeeds but sends nothing', async () => {
      await expect(
        requestLink().execute({ email: 'ghost@dispatch.example' }),
      ).resolves.toBeUndefined();
      expect(gateway().sent).toHaveLength(0);
    });

    it('consumes a token to mint a working, single-use session', async () => {
      await requestLink().execute({ email: 'boss@dispatch.example' });
      expect(gateway().sent[0]!.category).toBe('transactional');
      const token = tokenFromLastEmail(gateway());

      const session = await consumeLink().execute({ token });
      expect(session.accessToken).toBeTruthy();
      // The minted session is a normal one — its refresh token rotates.
      const rotated = await refresh().execute({ refreshToken: session.refreshToken });
      expect(rotated.accessToken).toBeTruthy();

      // The magic-link token cannot be replayed.
      await expect(consumeLink().execute({ token })).rejects.toBeInstanceOf(
        InvalidOneTimeTokenError,
      );
    });

    it('rejects an unknown or expired token', async () => {
      await expect(consumeLink().execute({ token: 'never-issued' })).rejects.toBeInstanceOf(
        InvalidOneTimeTokenError,
      );

      await requestLink().execute({ email: 'boss@dispatch.example' });
      const token = tokenFromLastEmail(gateway());
      vi.useFakeTimers();
      // Magic-link TTL is 15m by default.
      vi.setSystemTime(new Date(Date.now() + 900_001));
      try {
        await expect(consumeLink().execute({ token })).rejects.toBeInstanceOf(
          InvalidOneTimeTokenError,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
