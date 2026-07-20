import { inject, injectable } from 'inversify';
import { NEWSLETTER_TYPES } from '../types.js';
import type { Newsletter } from '../domain/newsletter.js';
import type { NewsletterRepository } from './newsletter-repository.js';
import type { ListNewslettersInput } from './dtos.js';

/**
 * Lists newsletters for one page. Fetches `limit + 1` rows so the presentation
 * layer can tell whether a next page exists and derive its cursor (`toPage`).
 */
@injectable()
export class ListNewsletters {
  constructor(
    @inject(NEWSLETTER_TYPES.NewsletterRepository)
    private readonly repository: NewsletterRepository,
  ) {}

  async execute(input: ListNewslettersInput): Promise<Newsletter[]> {
    return this.repository.list({ limit: input.limit + 1, cursor: input.cursor });
  }
}
