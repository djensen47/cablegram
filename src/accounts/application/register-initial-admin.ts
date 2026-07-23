import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import { User } from '../domain/user.js';
import { SetupAlreadyCompletedError } from '../domain/errors.js';
import type { UserRepository } from './user-repository.js';
import type { PasswordHasher } from './password-hasher.js';
import type { RegisterInitialAdminInput } from './dtos.js';

/**
 * First-run bootstrap (ADR-013): create the initial account and make it the
 * `admin`. Only permitted on a fresh instance — if any user already exists this
 * throws `SetupAlreadyCompletedError` (the edge maps it to 409). Thereafter,
 * user creation is admin-only via `CreateUser`.
 *
 * Note: the `countAll() === 0` check is not transactional, so two setup calls
 * racing on a truly empty instance could both create an admin. That is a benign
 * bootstrap edge (an operator setting up once), not a runtime path; the unique
 * email index still prevents two accounts sharing an address.
 */
@injectable()
export class RegisterInitialAdmin {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: RegisterInitialAdminInput): Promise<User> {
    if ((await this.users.countAll()) !== 0) {
      throw new SetupAlreadyCompletedError();
    }
    const passwordHash = await this.hasher.hash(input.password);
    const user = User.create({
      id: newId(),
      email: input.email,
      passwordHash,
      role: 'admin',
      now: this.clock.now(),
    });
    await this.users.create(user);
    return user;
  }
}
