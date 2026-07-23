import { inject, injectable } from 'inversify';
import { ACCOUNTS_TYPES } from '../types.js';
import type { User } from '../domain/user.js';
import type { UserRepository } from './user-repository.js';
import type { ListUsersInput } from './dtos.js';

/**
 * List user accounts (ADR-013), admin-only at the edge. Fetches `limit + 1`
 * rows so the presentation layer can detect a next page (`toPage`); ordered by
 * id with an exclusive cursor (ADR-012 portable subset).
 */
@injectable()
export class ListUsers {
  constructor(
    @inject(ACCOUNTS_TYPES.UserRepository) private readonly users: UserRepository,
  ) {}

  async execute(input: ListUsersInput): Promise<User[]> {
    return this.users.list({ limit: input.limit + 1, cursor: input.cursor });
  }
}
