import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { EMAIL_TYPES, type DeliveryGateway } from '../../shared/email/index.js';
import { CAMPAIGN_TYPES } from '../types.js';
import type { CampaignId } from '../domain/campaign.js';
import {
  CampaignNotFoundError,
  CampaignNewsletterNotFoundError,
  InvalidCampaignError,
} from '../domain/errors.js';
import type { CampaignRepository } from './campaign-repository.js';
import type { NewsletterGateway } from './newsletter-gateway.js';
import type { SuppressionGateway } from './suppression-gateway.js';
import type { MessageRenderer } from './message-renderer.js';
import { unsubscribeHeaders } from './unsubscribe-headers.js';

/**
 * How many addresses one test send may target. A proof, not a mailing: five is
 * enough for the operator plus a couple of inbox-rendering accounts (Gmail,
 * Outlook), and small enough that this can never become a side door onto the
 * list. Enforced here rather than only at the edge so the cap is the use case's
 * invariant, not the HTTP schema's.
 */
export const MAX_TEST_RECIPIENTS = 5;

/**
 * Prepended to the rendered subject unless the caller opts out (ADR-025 §4), so
 * a proof landing in a shared inbox is never mistaken for the real issue. Pass
 * `prefixSubject: false` when you need the subject byte-identical to what
 * subscribers will see — subject truncation in an inbox list is a real thing to
 * check, and the prefix moves it.
 */
export const TEST_SEND_SUBJECT_PREFIX = '[TEST] ';

/**
 * Prefix for the provider correlation tag on a test send. A real send tags with
 * the bare campaign id so webhooks correlate to it; a test send must NOT, or a
 * bounce or open on the proof would be applied to the campaign's real recipient
 * outcomes. `test:<id>` is deliberately not a campaign id, so
 * `RecordDeliveryEvents` looks it up, finds nothing, and skips the event — while
 * the tag still names the campaign in Postmark's own activity view.
 */
export const TEST_SEND_TAG_PREFIX = 'test:';

export interface SendTestCampaignInput {
  readonly campaignId: CampaignId;
  /** The only recipients. No subscriber list is read, ever. */
  readonly addresses: readonly string[];
  /** `false` sends the subject exactly as subscribers would see it. */
  readonly prefixSubject: boolean;
}

/** What a test send did. Nothing about it is persisted — this is the whole record. */
export interface TestSendResult {
  readonly campaignId: CampaignId;
  /** The subject as actually submitted, prefix included when one was applied. */
  readonly subject: string;
  readonly sent: readonly string[];
  /** Requested addresses dropped because they are on the global suppression list. */
  readonly suppressed: readonly string[];
  /** The provider's bulk request id, or `null` when every address was suppressed. */
  readonly bulkRequestId: string | null;
}

/**
 * Deliver a campaign to a handful of named addresses, so the operator can see
 * what the real send will look like in a real inbox (ADR-025). A browser
 * preview does not substitute — Gmail and Outlook rewrite email HTML, which is
 * the entire reason the compiled MJML has to be proved by mail.
 *
 * It is faithful **by sharing the send path's code, not by resembling it**:
 * the same `MessageRenderer.render(campaign.contentRef(), {})` call, the same
 * `unsubscribeHeaders(...)`, the same `broadcast` category (so the same Postmark
 * stream, token and reputation path), the same `DeliveryGateway`. If any of
 * that were re-implemented here, a green test send would prove nothing about
 * the real one.
 *
 * It leaves **no trace**: no `Send`, no `RecipientOutcome`, no stats movement,
 * no state transition — the campaign is read and never written. Safe to run
 * twenty times while iterating on a template, and legal in any status (a
 * `sent` campaign answers "what did we actually send?" at no cost).
 *
 * The two gates of a real send are deliberately asymmetric here (ADR-025 §1–2):
 * `resolveRecipients` is never called — the addresses ARE the recipient set —
 * but the global suppression list still applies, because the list exists to stop
 * cablegram mailing dead mailboxes and an operator-triggered path is not an
 * exception to that.
 */
@injectable()
export class SendTestCampaign {
  constructor(
    @inject(CAMPAIGN_TYPES.CampaignRepository)
    private readonly campaigns: CampaignRepository,
    @inject(CAMPAIGN_TYPES.NewsletterGateway)
    private readonly newsletters: NewsletterGateway,
    @inject(CAMPAIGN_TYPES.SuppressionGateway)
    private readonly suppression: SuppressionGateway,
    @inject(CAMPAIGN_TYPES.MessageRenderer)
    private readonly renderer: MessageRenderer,
    @inject(EMAIL_TYPES.DeliveryGateway) private readonly delivery: DeliveryGateway,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async execute(input: SendTestCampaignInput): Promise<TestSendResult> {
    // Normalized the same way subscription and suppression keys are, so
    // `Me@Example.COM` matches its own suppression entry; de-duplicated so a
    // repeated address is not mailed twice and cannot pad the cap.
    const addresses = [...new Set(input.addresses.map(normalizeEmailAddress))];
    if (addresses.length === 0) {
      throw new InvalidCampaignError('to', 'requires at least one address');
    }
    if (addresses.length > MAX_TEST_RECIPIENTS) {
      throw new InvalidCampaignError('to', `accepts at most ${MAX_TEST_RECIPIENTS} addresses`);
    }

    const campaign = await this.campaigns.findById(input.campaignId);
    if (campaign === null) {
      throw new CampaignNotFoundError(input.campaignId);
    }
    // Same fail-fast as the real send: without a sender identity there is no
    // faithful message to prove.
    const sender = await this.newsletters.find(campaign.newsletterId);
    if (sender === null) {
      throw new CampaignNewsletterNotFoundError(campaign.newsletterId);
    }

    const suppressed = new Set(await this.suppression.filterSuppressed(addresses));
    const allowed = addresses.filter((address) => !suppressed.has(address));

    // THE call the real send makes — same method, same content ref, same empty
    // model (a broadcast is one shared body, ADR-008). A bad template fails a
    // test send exactly as it fails a real one, which is the point.
    const message = await this.renderer.render(campaign.contentRef(), {});
    const subject = input.prefixSubject
      ? `${TEST_SEND_SUBJECT_PREFIX}${message.subject}`
      : message.subject;

    if (allowed.length === 0) {
      return {
        campaignId: campaign.id,
        subject,
        sent: [],
        suppressed: [...suppressed],
        bulkRequestId: null,
      };
    }

    const ack = await this.delivery.send({
      from: {
        fromName: sender.fromName,
        fromEmail: sender.fromEmail,
        replyTo: sender.replyTo,
      },
      content: {
        subject,
        htmlBody: message.htmlBody,
        textBody: message.textBody,
      },
      // A test address has no subscription, so the header is bound to a fresh
      // synthetic id (ADR-025 §3). The token verifies, so the mail client
      // renders the unsubscribe affordance and the operator can see it; the
      // one-click POST then hits `PublicUnsubscribe`'s valid-token/no-row path
      // and quietly does nothing (ADR-015).
      recipients: allowed.map((address) => {
        const headers = unsubscribeHeaders(this.config, campaign.newsletterId, newId(), address);
        return headers === undefined ? { email: address } : { email: address, headers };
      }),
      // Faithful to the real send: broadcast stream, broadcast token.
      category: 'broadcast',
      // NOT the campaign id — see TEST_SEND_TAG_PREFIX. Events for this message
      // must never reach the campaign's outcomes.
      tag: `${TEST_SEND_TAG_PREFIX}${campaign.id}`,
    });

    return {
      campaignId: campaign.id,
      subject,
      sent: allowed,
      suppressed: [...suppressed],
      bulkRequestId: ack.bulkRequestId,
    };
  }
}
