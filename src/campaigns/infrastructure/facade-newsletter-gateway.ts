import { inject, injectable } from 'inversify';
import { GetNewsletter, NEWSLETTER_TYPES, NewsletterNotFoundError } from '../../newsletters/index.js';
import type { CampaignSender, NewsletterGateway } from '../application/newsletter-gateway.js';

/**
 * The adapter fulfilling the `NewsletterGateway` port over the `newsletters`
 * facade (ADR-005 #3 + the ADR-011 DAG edge `campaigns → newsletters`). It
 * resolves a newsletter through `GetNewsletter`, translating "not found" into
 * the `null` the port promises, and projects the aggregate down to the sender
 * identity a send needs.
 */
@injectable()
export class FacadeNewsletterGateway implements NewsletterGateway {
  constructor(
    @inject(NEWSLETTER_TYPES.GetNewsletter) private readonly getNewsletter: GetNewsletter,
  ) {}

  async find(newsletterId: string): Promise<CampaignSender | null> {
    try {
      const newsletter = await this.getNewsletter.execute(newsletterId);
      return {
        fromName: newsletter.fromName,
        fromEmail: newsletter.fromEmail.value,
        replyTo: newsletter.replyTo?.value ?? null,
      };
    } catch (err) {
      if (err instanceof NewsletterNotFoundError) return null;
      throw err;
    }
  }
}
