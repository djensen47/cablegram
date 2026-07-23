import { injectable } from 'inversify';
import { User } from '../domain/user.js';
import type { ListUsersOptions, UserRepository } from '../application/user-repository.js';

/**
 * A real in-memory `UserRepository` (not a mock) — the DI-rebind test seam
 * (ADR-003). Mirrors the Mongo repository's contract exactly: id ordering,
 * exclusive cursor, `limit` cap, email lookup, `countAll`, so use-case and
 * route tests exercise the same behavior the Mongo-backed repository honors.
 */
@injectable()
export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();

  async create(user: User): Promise<void> {
    this.byId.set(user.id, user);
  }

  async update(user: User): Promise<void> {
    this.byId.set(user.id, user);
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.byId.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async list(options: ListUsersOptions): Promise<User[]> {
    const ordered = [...this.byId.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const filtered =
      options.cursor === undefined ? ordered : ordered.filter((u) => u.id > options.cursor!);
    return filtered.slice(0, options.limit);
  }

  async countAll(): Promise<number> {
    return this.byId.size;
  }
}
