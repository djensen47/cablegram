import { inject, injectable } from 'inversify';
import type { Collection, Db, Filter } from 'mongodb';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { COLLECTIONS } from '../../shared/persistence/index.js';
import { Campaign, type CampaignId, type CampaignStats, type CampaignStatus } from '../domain/campaign.js';
import type {
  CampaignRepository,
  ListCampaignsOptions,
} from '../application/campaign-repository.js';

/**
 * The stored document shape (ADR-012): the app string id is the `_id`;
 * `newsletterId`/`templateId` are plain id references (no embedded documents);
 * `segmentTags` is a scalar array and `stats` a nested BSON object (an opaque
 * snapshot, like `subscriptions.mergeFields`).
 */
interface CampaignDoc {
  _id: string;
  newsletterId: string;
  name: string;
  templateId: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  segmentTags: string[];
  status: string;
  sendId: string | null;
  stats: CampaignStats;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

/**
 * The Mongo-backed `CampaignRepository` (ADR-012). The native driver stays
 * sealed inside this class: it maps documents to/from the domain aggregate and
 * never lets a driver type escape into `application/` or `domain/`. Pagination
 * is an id-ordered, exclusive-cursor sweep (`_id > cursor`) — the portable
 * subset, no skip/offset. `stats` is stored as an opaque nested object.
 */
@injectable()
export class MongoCampaignRepository implements CampaignRepository {
  private readonly collection: Collection<CampaignDoc>;

  constructor(@inject(SHARED_TYPES.MongoDb) db: Db) {
    this.collection = db.collection<CampaignDoc>(COLLECTIONS.campaigns);
  }

  async create(campaign: Campaign): Promise<void> {
    await this.collection.insertOne(toDoc(campaign));
  }

  async update(campaign: Campaign): Promise<void> {
    await this.collection.replaceOne({ _id: campaign.id }, toDoc(campaign));
  }

  async findById(id: CampaignId): Promise<Campaign | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc === null ? null : toDomain(doc);
  }

  async list(options: ListCampaignsOptions): Promise<Campaign[]> {
    const filter: Filter<CampaignDoc> = {
      ...(options.newsletterId === undefined ? {} : { newsletterId: options.newsletterId }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.cursor === undefined ? {} : { _id: { $gt: options.cursor } }),
    };
    const docs = await this.collection.find(filter).sort({ _id: 1 }).limit(options.limit).toArray();
    return docs.map(toDomain);
  }

  async delete(id: CampaignId): Promise<boolean> {
    const { deletedCount } = await this.collection.deleteOne({ _id: id });
    return deletedCount > 0;
  }
}

function toDoc(campaign: Campaign): CampaignDoc {
  return {
    _id: campaign.id,
    newsletterId: campaign.newsletterId,
    name: campaign.name,
    templateId: campaign.templateId,
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    bodyText: campaign.bodyText,
    segmentTags: [...campaign.segmentTags],
    status: campaign.status,
    sendId: campaign.sendId,
    stats: campaign.stats,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    sentAt: campaign.sentAt,
  };
}

function toDomain(doc: CampaignDoc): Campaign {
  // `status` is only ever written from the closed `CampaignStatus` set and
  // `stats` from a `CampaignStats` object, so a stored document is trusted at
  // the repository boundary (same stance as sibling repositories).
  return Campaign.reconstitute({
    id: doc._id,
    newsletterId: doc.newsletterId,
    name: doc.name,
    templateId: doc.templateId,
    subject: doc.subject,
    bodyHtml: doc.bodyHtml,
    bodyText: doc.bodyText,
    segmentTags: doc.segmentTags,
    status: doc.status as CampaignStatus,
    sendId: doc.sendId,
    stats: doc.stats,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    sentAt: doc.sentAt,
  });
}
