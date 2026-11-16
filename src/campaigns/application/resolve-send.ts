import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { Campaign, CampaignId } from '../domain/campaign.js';
import { CampaignNotFoundError, CampaignStateError } from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { SendRepository } from './send-repository.js';
import type { RecipientOutcomeRepository } from './recipient-outcome-repository.js';

/** What an operator can record about a send whose outcome cablegram does not know. */
export const SEND_RESOLUTIONS = ['sent', 'not-sent'] as const;
export type SendResolution = (typeof SEND_RESOLUTIONS)[number];

/**
 * How long after a send was started it may first be resolved as `not-sent`.
 *
 * A campaign in `sending` looks the same whether its request died or is still
 * waiting on the provider — nothing is kept in the process to tell them apart
 * (ADR-009), and a client that gave up waiting says nothing about the server.
 * Resolving a send as `not-sent` while its request is still running, and then
 * sending again, is the double send this whole path exists to prevent. Fifteen
 * minutes is longer than a request can run: the provider call is bounded by
 * Node's `fetch` timeouts (five minutes for the response headers, five for the
 * body), and everything before it is a handful of store writes.
 *
 * `sent` needs no wait: if the request is still running, it finishes into the
 * same state.
 */
export const NOT_SENT_WAIT_MS = 15 * 60 * 1000;

export interface ResolveSendInput {
  campaignId: CampaignId;
  outcome: SendResolution;
}

/**
 * Settles a send that was started and never confirmed either way (ADR-035).
 *
 * `SendCampaign` leaves a campaign in `sending` whenever it cannot be sure the
 * provider does not have the broadcast, and refuses to start another send from
 * there. That is safe and it is also a dead end: only someone who can look at
 * the provider knows what happened. This records their answer.
 *
 *  - `sent`     — the provider has it. The recipients are raised to `accepted`
 *    and the campaign becomes `sent`.
 *  - `not-sent` — the provider has nothing. The campaign becomes `failed`, and
 *    a `failed` campaign can be sent again.
 *
 * `not-sent` is the dangerous answer — a wrong one mails the list twice — so it
 * is refused whenever cablegram itself holds evidence against it: a stored
 * provider acknowledgment, delivery events already recorded for the send, or a
 * send too recent to have finished ({@link NOT_SENT_WAIT_MS}).
 */
@injectable()
export class ResolveSend {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.SendRepository)
    private readonly sends: SendRepository,
    @inject(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    private readonly outcomes: RecipientOutcomeRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute({ campaignId, outcome }: ResolveSendInput): Promise<Campaign> {
    const campaign = await this.campaigns.findById(campaignId);
    if (campaign === null) {
      throw new CampaignNotFoundError(campaignId);
    }
    if (!campaign.isSending) {
      throw new CampaignStateError(
        `only a campaign left in "sending" has a send to resolve; this one is "${campaign.status}"`,
      );
    }

    const send = campaign.sendId === null ? null : await this.sends.findById(campaign.sendId);
    const now = this.clock.now();

    if (outcome === 'sent') {
      // The send record is opened before the provider is called, so a campaign
      // without one never reached the provider.
      if (send === null) {
        throw new CampaignStateError(
          'no send record was opened for this campaign, so nothing was submitted; ' +
            'resolve it as not-sent',
        );
      }
      await this.outcomes.markAccepted(send.id, now);
      campaign.markSent(send.recipientCount, now);
    } else {
      if (send !== null) {
        if (send.bulkRequestId !== null) {
          throw new CampaignStateError(
            `the provider acknowledged this send (bulk request ${send.bulkRequestId}); ` +
              'resolve it as sent',
          );
        }
        // Nothing here raised a recipient past `pending`, so any that moved did
        // so because a delivery event arrived — which only a submitted send
        // produces.
        const { accepted } = await this.outcomes.stats(send.id);
        if (accepted > 0) {
          throw new CampaignStateError(
            `delivery events have arrived for ${accepted} recipient(s) of this send, so the ` +
              'provider has it; resolve it as sent',
          );
        }
      }
      const readyAt = new Date(campaign.updatedAt.getTime() + NOT_SENT_WAIT_MS);
      if (now < readyAt) {
        throw new CampaignStateError(
          `this send was started at ${campaign.updatedAt.toISOString()} and may still be in ` +
            `progress; it can be resolved as not-sent after ${readyAt.toISOString()}`,
        );
      }
      campaign.markFailed(now);
    }

    if (!(await this.campaigns.saveIfStatus(campaign, ['sending']))) {
      throw new CampaignStateError('the campaign changed while it was being resolved; read it again');
    }
    return campaign;
  }
}
