import { inject, injectable } from 'inversify';
import { ACCOUNTS_TYPES } from '../types.js';
import { User } from '../domain/user.js';
import { UserNotFoundError } from '../domain/errors.js';
import type { UserRepository } from './user-repository.js';

/** Fetch a single user by id (ADR-013), admin-only at the edge. */
@injectable()
export class GetUser {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
  ) {}

  async execute(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (user === null) {
      throw new UserNotFoundError(id);
    }
    return user;
  }
}
