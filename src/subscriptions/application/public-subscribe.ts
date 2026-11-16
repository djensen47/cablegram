import { inject, injectable } from 'inversify';
import { CAPTCHA_TYPES, type CaptchaVerifier } from '../../shared/captcha/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import type { ConsentEvidence, CustomFields } from '../domain/subscription.js';
import {
  InvalidCaptchaError,
  PublicSignupUnavailableError,
  SubscriptionNewsletterNotFoundError,
} from '../domain/errors.js';
import type { NewsletterDirectory } from './newsletter-directory.js';
import type { Subscribe } from './subscribe.js';

export interface PublicSubscribeInput {
  readonly newsletterId: string;
  readonly email: string;
  readonly customFields?: CustomFields;
  /** The token the visitor's browser got from the Turnstile widget. */
  readonly captchaToken: string;
  /**
   * Read off the request by the route (ADR-023): on this route the caller *is*
   * the subscriber's browser, so its IP and user agent are real evidence.
   */
  readonly evidence: ConsentEvidence;
}

/**
 * Public signup (ADR-034): `POST /v1/subscribe`, called straight from a form on
 * the operator's site, with no session. It is the ordinary `Subscribe`, behind
 * three gates and one restriction:
 *
 *  1. **Public signup must be configured** — a Turnstile secret. Without one
 *     the route is unavailable (503), never unprotected.
 *  2. **The captcha must pass**, checked *before* the newsletter is looked up,
 *     so a bot cannot probe which newsletter ids exist.
 *  3. **The newsletter must have `publicSignup` on.** A closed or unknown
 *     newsletter is the same 404, so the two are indistinguishable.
 *
 * The restriction: an address that **left** (unsubscribed, bounced or
 * complained) is **not** revived by a public *single* opt-in signup. Anyone
 * can type any address into a public form; with no confirmation email there is
 * no proof the request came from the mailbox's owner, and re-subscribing
 * someone who opted out is the one thing that must never happen on a guess.
 * Under double opt-in the revival waits for the confirmation, so it is allowed.
 * Either way the response is the same (non-revealing): the caller cannot learn
 * whether an address is on the list.
 *
 * Opt-in mode follows the newsletter (ADR-032); a public caller cannot choose.
 */
@injectable()
export class PublicSubscribe {
  constructor(
    @inject(CAPTCHA_TYPES.CaptchaVerifier) private readonly captcha: CaptchaVerifier,
    @inject(SUBSCRIPTION_TYPES.NewsletterDirectory)
    private readonly newsletters: NewsletterDirectory,
    @inject(SUBSCRIPTION_TYPES.Subscribe) private readonly subscribe: Subscribe,
  ) {}

  async execute(input: PublicSubscribeInput): Promise<void> {
    if (!this.captcha.configured) throw new PublicSignupUnavailableError();
    if (!(await this.captcha.verify(input.captchaToken, input.evidence.ip))) {
      throw new InvalidCaptchaError();
    }

    const newsletter = await this.newsletters.find(input.newsletterId);
    if (newsletter === null || !newsletter.publicSignup) {
      throw new SubscriptionNewsletterNotFoundError(input.newsletterId);
    }

    await this.subscribe.execute({
      newsletterId: input.newsletterId,
      email: input.email,
      customFields: input.customFields,
      evidence: input.evidence,
      reviveLapsedWithoutConfirmation: false,
    });
  }
}
