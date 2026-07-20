import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { EMAIL_TYPES, type DeliveryGateway } from '../../shared/email/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import { Subscription } from '../domain/subscription.js';
import { SubscriptionNewsletterNotFoundError } from '../domain/errors.js';
import type { SubscriptionRepository } from './subscription-repository.js';
import type { NewsletterDirectory, NewsletterInfo } from './newsletter-directory.js';
import type { SubscribeInput } from './dtos.js';

/** Confirmation emails ride the transactional stream, not the broadcast stream. */
const TRANSACTIONAL_STREAM = 'outbound';

/**
 * Subscribe an address to a newsletter (ADR-011). Validates the target
 * newsletter exists (via the consumer-owned `NewsletterDirectory` port),
 * enforces per-newsletter single/double opt-in, and honours the flat
 * per-newsletter model:
 *  - a fresh address → a new `Subscription` row;
 *  - an already-`pending`/`subscribed` address → returned unchanged (idempotent);
 *  - a previously `unsubscribed` address → the **same row is revived**, never
 *    a duplicate.
 *
 * Under double opt-in the resulting `pending` subscription triggers exactly one
 * transactional confirmation email through the shared `email` gateway (ADR-008);
 * single opt-in sends nothing.
 */
@injectable()
export class Subscribe {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
    @inject(SUBSCRIPTION_TYPES.NewsletterDirectory)
    private readonly newsletters: NewsletterDirectory,
    @inject(EMAIL_TYPES.DeliveryGateway) private readonly delivery: DeliveryGateway,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: SubscribeInput): Promise<Subscription> {
    const newsletter = await this.newsletters.find(input.newsletterId);
    if (newsletter === null) {
      throw new SubscriptionNewsletterNotFoundError(input.newsletterId);
    }

    const doubleOptIn = input.doubleOptIn ?? true;
    const email = normalizeEmailAddress(input.email);
    const existing = await this.repository.findByNewsletterAndEmail(input.newsletterId, email);

    if (existing !== null) {
      // Only a lapsed row is revived; an active (pending/subscribed) membership
      // is returned untouched — re-subscribing is idempotent, never duplicative.
      if (existing.status !== 'unsubscribed') {
        return existing;
      }
      existing.resubscribe({
        mergeFields: input.mergeFields,
        tags: input.tags,
        doubleOptIn,
        now: this.clock.now(),
      });
      await this.repository.update(existing);
      if (existing.needsConfirmation) {
        await this.sendConfirmation(newsletter, existing);
      }
      return existing;
    }

    const subscription = Subscription.create({
      id: newId(),
      newsletterId: input.newsletterId,
      email: input.email,
      mergeFields: input.mergeFields,
      tags: input.tags,
      doubleOptIn,
      now: this.clock.now(),
    });
    await this.repository.create(subscription);
    if (subscription.needsConfirmation) {
      await this.sendConfirmation(newsletter, subscription);
    }
    return subscription;
  }

  private async sendConfirmation(
    newsletter: NewsletterInfo,
    subscription: Subscription,
  ): Promise<void> {
    // The confirm endpoint's own path is the confirmation reference — no extra
    // config/host coupling; the caller renders it into a link if it fronts a UI.
    const confirmPath =
      `/v1/newsletters/${subscription.newsletterId}` +
      `/subscriptions/${subscription.id}/confirm`;

    await this.delivery.send({
      from: {
        fromName: newsletter.fromName,
        fromEmail: newsletter.fromEmail,
        replyTo: newsletter.replyTo,
      },
      content: {
        subject: 'Confirm your subscription',
        htmlBody:
          `<p>Please confirm your subscription by confirming at ` +
          `<code>${confirmPath}</code>.</p>`,
        textBody: `Please confirm your subscription: ${confirmPath}`,
      },
      recipients: [{ email: subscription.email }],
      messageStream: TRANSACTIONAL_STREAM,
      tag: 'subscription-confirmation',
    });
  }
}
