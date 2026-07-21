import { ContainerModule } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignRepository } from '../application/campaign-repository.js';
import type { SendRecordRepository } from '../application/send-record-repository.js';
import type { NewsletterGateway } from '../application/newsletter-gateway.js';
import type { RecipientResolver } from '../application/recipient-resolver.js';
import type { SuppressionGateway } from '../application/suppression-gateway.js';
import type { MessageRenderer } from '../application/message-renderer.js';
import { CreateCampaign } from '../application/create-campaign.js';
import { GetCampaign } from '../application/get-campaign.js';
import { ListCampaigns } from '../application/list-campaigns.js';
import { UpdateCampaign } from '../application/update-campaign.js';
import { DeleteCampaign } from '../application/delete-campaign.js';
import { SendCampaign } from '../application/send-campaign.js';
import { GetSendRecord } from '../application/get-send-record.js';
import { RecordDeliveryEvents } from '../application/record-delivery-events.js';
import { DispatchDueCampaigns } from '../application/dispatch-due-campaigns.js';
import { MongoCampaignRepository } from './mongo-campaign-repository.js';
import { MongoSendRecordRepository } from './mongo-send-record-repository.js';
import { FacadeNewsletterGateway } from './facade-newsletter-gateway.js';
import { FacadeRecipientResolver } from './facade-recipient-resolver.js';
import { FacadeSuppressionGateway } from './facade-suppression-gateway.js';
import { FacadeMessageRenderer } from './facade-message-renderer.js';

/**
 * The campaigns component's DI wiring (ADR-003) — the integrator. Loaded by the
 * composition root; the canonical repositories are Mongo-backed here and the
 * cross-context ports are fulfilled by facade adapters along the ADR-011 DAG
 * (`campaigns → newsletters/subscriptions/deliverability/templates/email`).
 * Tests rebind the two repositories to their in-memory doubles and `email`'s
 * `DeliveryGateway` to its in-memory double, leaving the adapters wired to the
 * real (in-memory-backed) contexts so the send runs end-to-end. Interfaces only
 * are injected — never a concrete class.
 */
export const campaignModule = new ContainerModule((bind) => {
  bind<CampaignRepository>(CAMPAIGN_TYPES.CampaignRepository).to(MongoCampaignRepository);
  bind<SendRecordRepository>(CAMPAIGN_TYPES.SendRecordRepository).to(MongoSendRecordRepository);

  bind<NewsletterGateway>(CAMPAIGN_TYPES.NewsletterGateway).to(FacadeNewsletterGateway);
  bind<RecipientResolver>(CAMPAIGN_TYPES.RecipientResolver).to(FacadeRecipientResolver);
  bind<SuppressionGateway>(CAMPAIGN_TYPES.SuppressionGateway).to(FacadeSuppressionGateway);
  bind<MessageRenderer>(CAMPAIGN_TYPES.MessageRenderer).to(FacadeMessageRenderer);

  bind<CreateCampaign>(CAMPAIGN_TYPES.CreateCampaign).to(CreateCampaign);
  bind<GetCampaign>(CAMPAIGN_TYPES.GetCampaign).to(GetCampaign);
  bind<ListCampaigns>(CAMPAIGN_TYPES.ListCampaigns).to(ListCampaigns);
  bind<UpdateCampaign>(CAMPAIGN_TYPES.UpdateCampaign).to(UpdateCampaign);
  bind<DeleteCampaign>(CAMPAIGN_TYPES.DeleteCampaign).to(DeleteCampaign);
  bind<SendCampaign>(CAMPAIGN_TYPES.SendCampaign).to(SendCampaign);
  bind<GetSendRecord>(CAMPAIGN_TYPES.GetSendRecord).to(GetSendRecord);
  bind<RecordDeliveryEvents>(CAMPAIGN_TYPES.RecordDeliveryEvents).to(RecordDeliveryEvents);
  bind<DispatchDueCampaigns>(CAMPAIGN_TYPES.DispatchDueCampaigns).to(DispatchDueCampaigns);
});
