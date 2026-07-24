import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import type {
  OneTimeTokenPurpose,
  OneTimeTokenRepository,
  StoredOneTimeToken,
} from '../application/one-time-token-repository.js';

/**
 * The stored document shape (ADR-012): the SHA-256 token hash is the `_id`
 * (lookup by hash is free), `expiresAt` backs the TTL index that reaps used or
 * lapsed tokens (`ensureIndexes`), and `purpose` scopes the token to one flow.
 * The raw secret is never stored.
 */
interface OneTimeTokenDoc {
  _id: string;
  userId: string;
  purpose: OneTimeTokenPurpose;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The Mongo-backed `OneTimeTokenRepository` (ADR-012). Single-document writes,
 * no transactions — a standalone `mongod` suffices. The driver stays sealed in
 * this class.
 */
@injectable()
export class MongoOneTimeTokenRepository implements OneTimeTokenRepository {
  private readonly collection: Collection<OneTimeTokenDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<OneTimeTokenDoc>(COLLECTIONS.oneTimeTokens);
  }

  async create(token: StoredOneTimeToken): Promise<void> {
    await this.collection.insertOne({
      _id: token.tokenHash,
      userId: token.userId,
      purpose: token.purpose,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    });
  }

  async findByHash(tokenHash: string): Promise<StoredOneTimeToken | null> {
    const doc = await this.collection.findOne({ _id: tokenHash });
    return doc === null ? null : toDomain(doc);
  }

  async deleteByHash(tokenHash: string): Promise<boolean> {
    const { deletedCount } = await this.collection.deleteOne({ _id: tokenHash });
    return deletedCount > 0;
  }
}

function toDomain(doc: OneTimeTokenDoc): StoredOneTimeToken {
  return {
    tokenHash: doc._id,
    userId: doc.userId,
    purpose: doc.purpose,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}
