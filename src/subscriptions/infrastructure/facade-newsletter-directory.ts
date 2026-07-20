import { inject, injectable } from 'inversify';
import {
  GetNewsletter,
  NEWSLETTER_TYPES,
  NewsletterNotFoundError,
} from '../../newsletters/index.js';
import type {
  NewsletterDirectory,
  NewsletterInfo,
} from '../application/newsletter-directory.js';

/**
 * The adapter fulfilling the `NewsletterDirectory` port over the `newsletters`
 * facade (ADR-005 #3 + the ADR-011 DAG edge `subscriptions → newsletters`).
 * This is the *only* place in `subscriptions` that reaches across the component
 * boundary: it resolves a newsletter through the `GetNewsletter` use case,
 * translating its "not found" into a `null` the port promises, and projects the
 * aggregate down to the slice the subscribe use case needs.
 */
@injectable()
export class FacadeNewsletterDirectory implements NewsletterDirectory {
  constructor(
    @inject(NEWSLETTER_TYPES.GetNewsletter) private readonly getNewsletter: GetNewsletter,
  ) {}

  async find(newsletterId: string): Promise<NewsletterInfo | null> {
    try {
      const newsletter = await this.getNewsletter.execute(newsletterId);
      return {
        id: newsletter.id,
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
