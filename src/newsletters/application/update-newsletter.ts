import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { NEWSLETTER_TYPES } from '../types.js';
import { Newsletter, type NewsletterId } from '../domain/newsletter.js';
import { NewsletterNotFoundError } from '../domain/errors.js';
import type { NewsletterRepository } from './newsletter-repository.js';
import type { UpdateNewsletterInput } from './dtos.js';

/** Applies a partial change set to an existing newsletter and persists it. */
@injectable()
export class UpdateNewsletter {
  constructor(
    @inject(NEWSLETTER_TYPES.NewsletterRepository)
    private readonly repository: NewsletterRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(id: NewsletterId, changes: UpdateNewsletterInput): Promise<Newsletter> {
    const newsletter = await this.repository.findById(id);
    if (newsletter === null) {
      throw new NewsletterNotFoundError(id);
    }

    newsletter.update(changes, this.clock.now());
    await this.repository.update(newsletter);
    return newsletter;
  }
}
