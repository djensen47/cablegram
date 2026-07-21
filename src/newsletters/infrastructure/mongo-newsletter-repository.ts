import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import { EmailAddress, Newsletter, type NewsletterId } from '../domain/newsletter.js';
import type {
  ListNewslettersOptions,
  NewsletterRepository,
} from '../application/newsletter-repository.js';

/** The stored document shape (ADR-012): the app string id is the `_id`. */
interface NewsletterDoc {
  _id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  sendingDomain: string | null;
  dkimIdentifier: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `NewsletterRepository` (ADR-012). The native driver stays
 * sealed inside this class: it maps documents to/from the domain aggregate and
 * never lets a driver type escape into `application/` or `domain/`. Pagination
 * is an id-ordered, exclusive-cursor sweep (`_id > cursor`) — the portable
 * subset, no skip/offset.
 */
@injectable()
export class MongoNewsletterRepository implements NewsletterRepository {
  private readonly collection: Collection<NewsletterDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<NewsletterDoc>(COLLECTIONS.newsletters);
  }

  async create(newsletter: Newsletter): Promise<void> {
    await this.collection.insertOne(toDoc(newsletter));
  }

  async findById(id: NewsletterId): Promise<Newsletter | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }

  async list(options: ListNewslettersOptions): Promise<Newsletter[]> {
    const docs = await this.collection
      .find(options.cursor === undefined ? {} : { _id: { $gt: options.cursor } })
      .sort({ _id: 1 })
      .limit(options.limit)
      .toArray();
    return docs.map(toDomain);
  }

  async update(newsletter: Newsletter): Promise<void> {
    await this.collection.replaceOne({ _id: newsletter.id }, toDoc(newsletter));
  }

  async delete(id: NewsletterId): Promise<boolean> {
    const { deletedCount } = await this.collection.deleteOne({ _id: id });
    return deletedCount > 0;
  }
}

function toDoc(newsletter: Newsletter): NewsletterDoc {
  return {
    _id: newsletter.id,
    name: newsletter.name,
    fromName: newsletter.fromName,
    fromEmail: newsletter.fromEmail.value,
    replyTo: newsletter.replyTo?.value ?? null,
    sendingDomain: newsletter.sendingDomain,
    dkimIdentifier: newsletter.dkimIdentifier,
    createdAt: newsletter.createdAt,
    updatedAt: newsletter.updatedAt,
  };
}

function toDomain(doc: NewsletterDoc): Newsletter {
  return Newsletter.reconstitute({
    id: doc._id,
    name: doc.name,
    fromName: doc.fromName,
    fromEmail: EmailAddress.create(doc.fromEmail),
    replyTo: doc.replyTo === null ? null : EmailAddress.create(doc.replyTo),
    sendingDomain: doc.sendingDomain,
    dkimIdentifier: doc.dkimIdentifier,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
