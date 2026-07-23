import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import { User, type Role } from '../domain/user.js';
import type { ListUsersOptions, UserRepository } from '../application/user-repository.js';

/**
 * The stored document shape (ADR-012): the app string id is the `_id`; `email`
 * is a plain indexed field (unique index, ADR-013) so `findByEmail` is an
 * exact-match lookup.
 */
interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `UserRepository` (ADR-012). The native driver stays sealed
 * inside this class: it maps documents to/from the domain aggregate and never
 * lets a driver type escape into `application/` or `domain/`. Pagination is an
 * id-ordered, exclusive-cursor sweep (`_id > cursor`) — the portable subset, no
 * skip/offset. A duplicate email is rejected by the unique index (ADR-013).
 */
@injectable()
export class MongoUserRepository implements UserRepository {
  private readonly collection: Collection<UserDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<UserDoc>(COLLECTIONS.users);
  }

  async create(user: User): Promise<void> {
    await this.collection.insertOne(toDoc(user));
  }

  async update(user: User): Promise<void> {
    await this.collection.replaceOne({ _id: user.id }, toDoc(user));
  }

  async findById(id: string): Promise<User | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }

  async findByEmail(email: string): Promise<User | null> {
    const doc = await this.collection.findOne({ email });
    return doc === null ? null : toDomain(doc);
  }

  async list(options: ListUsersOptions): Promise<User[]> {
    const docs = await this.collection
      .find(options.cursor === undefined ? {} : { _id: { $gt: options.cursor } })
      .sort({ _id: 1 })
      .limit(options.limit)
      .toArray();
    return docs.map(toDomain);
  }

  async countAll(): Promise<number> {
    return this.collection.countDocuments({});
  }
}

function toDoc(user: User): UserDoc {
  return {
    _id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toDomain(doc: UserDoc): User {
  // `role` is only ever written from the closed `Role` set, so a stored
  // document's value is trusted at the repository boundary (same stance as
  // sibling repositories re-hydrating value objects, not enums).
  return User.reconstitute({
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    role: doc.role as Role,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
