import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { ACCOUNTS_TYPES } from '../types.js';
import { User } from '../domain/user.js';
import { EmailAlreadyExistsError } from '../domain/errors.js';
import type { UserRepository } from './user-repository.js';
import type { PasswordHasher } from './password-hasher.js';
import type { CreateUserInput } from './dtos.js';

/**
 * Create a user account (ADR-013). Admin-only — the route guards it with
 * `requireRole('admin')`; the use case itself just enforces the one-per-address
 * invariant (guarded by `findByEmail`, backstopped by the unique index) and
 * hashes the password before building the aggregate.
 */
@injectable()
export class CreateUser {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(ACCOUNTS_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: CreateUserInput): Promise<User> {
    const email = normalizeEmailAddress(input.email);
    if ((await this.users.findByEmail(email)) !== null) {
      throw new EmailAlreadyExistsError(email);
    }
    const passwordHash = await this.hasher.hash(input.password);
    const user = User.create({
      id: newId(),
      email: input.email,
      passwordHash,
      role: input.role,
      now: this.clock.now(),
    });
    await this.users.create(user);
    return user;
  }
}
