import { inject, injectable } from 'inversify';
import type { Collection, Db } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import { Template, type TemplateId } from '../domain/template.js';
import type {
  ListTemplatesOptions,
  TemplateRepository,
} from '../application/template-repository.js';

/** The stored document shape (ADR-012): the app string id is the `_id`. */
interface TemplateDoc {
  _id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Mongo-backed `TemplateRepository` (ADR-012). The native driver stays
 * sealed inside this class: it maps documents to/from the domain aggregate and
 * never lets a driver type escape into `application/` or `domain/`. Pagination
 * is an id-ordered, exclusive-cursor sweep (`_id > cursor`) — the portable
 * subset, no skip/offset.
 */
@injectable()
export class MongoTemplateRepository implements TemplateRepository {
  private readonly collection: Collection<TemplateDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<TemplateDoc>(COLLECTIONS.templates);
  }

  async create(template: Template): Promise<void> {
    await this.collection.insertOne(toDoc(template));
  }

  async findById(id: TemplateId): Promise<Template | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }

  async list(options: ListTemplatesOptions): Promise<Template[]> {
    const docs = await this.collection
      .find(options.cursor === undefined ? {} : { _id: { $gt: options.cursor } })
      .sort({ _id: 1 })
      .limit(options.limit)
      .toArray();
    return docs.map(toDomain);
  }

  async update(template: Template): Promise<void> {
    await this.collection.replaceOne({ _id: template.id }, toDoc(template));
  }

  async delete(id: TemplateId): Promise<boolean> {
    const { deletedCount } = await this.collection.deleteOne({ _id: id });
    return deletedCount > 0;
  }
}

function toDoc(template: Template): TemplateDoc {
  return {
    _id: template.id,
    name: template.name,
    subject: template.subject,
    bodyHtml: template.bodyHtml,
    bodyText: template.bodyText,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function toDomain(doc: TemplateDoc): Template {
  return Template.reconstitute({
    id: doc._id,
    name: doc.name,
    subject: doc.subject,
    bodyHtml: doc.bodyHtml,
    bodyText: doc.bodyText,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
