import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import type {
  RefreshTokenRepository,
  StoredRefreshToken,
} from '../application/refresh-token-repository.js';

/**
 * The stored document shape (ADR-012): the SHA-256 token hash is the `_id`
 * (lookup by hash is free), and `expiresAt` backs the TTL index that reaps
 * expired tokens (`ensureIndexes`). The raw refresh secret is never stored.
 */
interface RefreshTokenDoc {
  _id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The Mongo-backed `RefreshTokenRepository` (ADR-012). Single-document writes,
 * no transactions — a standalone `mongod` suffices. The driver stays sealed in
 * this class.
 */
@injectable()
export class MongoRefreshTokenRepository implements RefreshTokenRepository {
  private readonly collection: Collection<RefreshTokenDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<RefreshTokenDoc>(COLLECTIONS.refreshTokens);
  }

  async create(token: StoredRefreshToken): Promise<void> {
    await this.collection.insertOne({
      _id: token.tokenHash,
      userId: token.userId,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    });
  }

  async findByHash(tokenHash: string): Promise<StoredRefreshToken | null> {
    const doc = await this.collection.findOne({ _id: tokenHash });
    return doc === null ? null : toDomain(doc);
  }

  async deleteByHash(tokenHash: string): Promise<boolean> {
    const { deletedCount } = await this.collection.deleteOne({ _id: tokenHash });
    return deletedCount > 0;
  }
}

function toDomain(doc: RefreshTokenDoc): StoredRefreshToken {
  return {
    tokenHash: doc._id,
    userId: doc.userId,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}
