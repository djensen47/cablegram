/**
 * DI tokens for the campaigns component (ADR-003). A pure-Symbol leaf that
 * every layer of this component may import; the concrete bindings live in the
 * `ContainerModule` (infrastructure). Tests rebind the two repositories to
 * in-memory doubles and `email`'s `DeliveryGateway` to its in-memory double,
 * leaving the cross-context ports wired to the real facades (the integrator
 * runs end-to-end on in-memory storage, no DB — ADR-011).
 */
export const CAMPAIGN_TYPES = {
  CampaignRepository: Symbol.for('CampaignRepository'),
  SendRecordRepository: Symbol.for('SendRecordRepository'),
  /** Consumer-owned port over the `newsletters` facade (existence + sender identity). */
  NewsletterGateway: Symbol.for('CampaignsNewsletterGateway'),
  /** Consumer-owned port over the `subscriptions` facade (gate 1: subscribed recipients). */
  RecipientResolver: Symbol.for('CampaignsRecipientResolver'),
  /** Consumer-owned port over the `deliverability` facade (gate 2 + suppression writes). */
  SuppressionGateway: Symbol.for('CampaignsSuppressionGateway'),
  /** Consumer-owned port over the `templates` facade (content resolution + render). */
  MessageRenderer: Symbol.for('CampaignsMessageRenderer'),
  CreateCampaign: Symbol.for('CreateCampaign'),
  GetCampaign: Symbol.for('GetCampaign'),
  ListCampaigns: Symbol.for('ListCampaigns'),
  UpdateCampaign: Symbol.for('UpdateCampaign'),
  DeleteCampaign: Symbol.for('DeleteCampaign'),
  SendCampaign: Symbol.for('SendCampaign'),
  GetSendRecord: Symbol.for('GetSendRecord'),
  RecordDeliveryEvents: Symbol.for('RecordDeliveryEvents'),
} as const;
