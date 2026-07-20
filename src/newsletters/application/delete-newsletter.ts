import { inject, injectable } from 'inversify';
import { NEWSLETTER_TYPES } from '../types.js';
import type { NewsletterId } from '../domain/newsletter.js';
import { NewsletterNotFoundError } from '../domain/errors.js';
import type { NewsletterRepository } from './newsletter-repository.js';

/** Deletes a newsletter by id, or throws `NewsletterNotFoundError` if absent. */
@injectable()
export class DeleteNewsletter {
  constructor(
    @inject(NEWSLETTER_TYPES.NewsletterRepository)
    private readonly repository: NewsletterRepository,
  ) {}

  async execute(id: NewsletterId): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      throw new NewsletterNotFoundError(id);
    }
  }
}
