import { inject, injectable } from 'inversify';
import { NEWSLETTER_TYPES } from '../types.js';
import { Newsletter, type NewsletterId } from '../domain/newsletter.js';
import { NewsletterNotFoundError } from '../domain/errors.js';
import type { NewsletterRepository } from './newsletter-repository.js';

/** Fetches one newsletter by id, or throws `NewsletterNotFoundError`. */
@injectable()
export class GetNewsletter {
  constructor(
    @inject(NEWSLETTER_TYPES.NewsletterRepository)
    private readonly repository: NewsletterRepository,
  ) {}

  async execute(id: NewsletterId): Promise<Newsletter> {
    const newsletter = await this.repository.findById(id);
    if (newsletter === null) {
      throw new NewsletterNotFoundError(id);
    }
    return newsletter;
  }
}
