// Facade for the campaigns component (ADR-002/005): import only from here.
// Everything below is the component's public surface; internals are reached
// only through these exports. Campaigns is the integrator (ADR-011): it imports
// newsletters, subscriptions, deliverability, templates and email via their
// facades; nothing imports campaigns.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { campaignModule } from './infrastructure/module.js';
export { CAMPAIGN_TYPES } from './types.js';

// HTTP routers: the /v1 API surface, and the top-level Postmark webhook receiver.
export { createCampaignRoutes } from './presentation/routes.js';
export { createPostmarkWebhookRoutes } from './presentation/webhook-routes.js';

// In-memory repositories: the DI-rebind test doubles (ADR-003).
export { InMemoryCampaignRepository } from './infrastructure/in-memory-campaign-repository.js';
export { InMemorySendRecordRepository } from './infrastructure/in-memory-send-record-repository.js';

// Domain + application contracts consumers may need to type against.
export {
  Campaign,
  CAMPAIGN_STATUSES,
  isCampaignStatus,
  zeroStats,
  type CampaignId,
  type CampaignStatus,
  type CampaignStats,
  type CampaignContentRef,
  type CampaignSegment,
} from './domain/campaign.js';
export {
  SendRecord,
  OUTCOME_STATUSES,
  type SendRecordId,
  type OutcomeStatus,
  type RecipientOutcome,
} from './domain/send-record.js';
export {
  CampaignError,
  InvalidCampaignError,
  CampaignNotFoundError,
  CampaignNewsletterNotFoundError,
  CampaignStateError,
  CampaignContentError,
  SendRecordNotFoundError,
} from './domain/errors.js';
export type { CampaignRepository, ListCampaignsOptions } from './application/campaign-repository.js';
export type { SendRecordRepository } from './application/send-record-repository.js';
export type { NewsletterGateway, CampaignSender } from './application/newsletter-gateway.js';
export type { RecipientResolver, CampaignRecipient } from './application/recipient-resolver.js';
export type { SuppressionGateway } from './application/suppression-gateway.js';
export type { MessageRenderer, RenderedCampaignMessage } from './application/message-renderer.js';
export type {
  CreateCampaignInput,
  UpdateCampaignInput,
  ListCampaignsInput,
} from './application/dtos.js';

// Use case classes (resolved from the container by token; typed here for tests).
export { CreateCampaign } from './application/create-campaign.js';
export { GetCampaign } from './application/get-campaign.js';
export { ListCampaigns } from './application/list-campaigns.js';
export { UpdateCampaign } from './application/update-campaign.js';
export { DeleteCampaign } from './application/delete-campaign.js';
export { SendCampaign } from './application/send-campaign.js';
export { GetSendRecord } from './application/get-send-record.js';
export { RecordDeliveryEvents } from './application/record-delivery-events.js';
