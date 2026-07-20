import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { NEWSLETTER_TYPES } from '../types.js';
import { Newsletter } from '../domain/newsletter.js';
import type { NewsletterRepository } from './newsletter-repository.js';
import type { CreateNewsletterInput } from './dtos.js';

/** Creates a newsletter: mint an id, build a validated aggregate, persist it. */
@injectable()
export class CreateNewsletter {
  constructor(
    @inject(NEWSLETTER_TYPES.NewsletterRepository)
    private readonly repository: NewsletterRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: CreateNewsletterInput): Promise<Newsletter> {
    const newsletter = Newsletter.create({
      id: newId(),
      name: input.name,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      replyTo: input.replyTo,
      sendingDomain: input.sendingDomain,
      dkimIdentifier: input.dkimIdentifier,
      now: this.clock.now(),
    });

    await this.repository.create(newsletter);
    return newsletter;
  }
}
