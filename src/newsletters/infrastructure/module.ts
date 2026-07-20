import { ContainerModule } from 'inversify';
import { NEWSLETTER_TYPES } from '../types.js';
import type { NewsletterRepository } from '../application/newsletter-repository.js';
import { CreateNewsletter } from '../application/create-newsletter.js';
import { GetNewsletter } from '../application/get-newsletter.js';
import { ListNewsletters } from '../application/list-newsletters.js';
import { UpdateNewsletter } from '../application/update-newsletter.js';
import { DeleteNewsletter } from '../application/delete-newsletter.js';
import { PrismaNewsletterRepository } from './prisma-newsletter-repository.js';

/**
 * The newsletters component's DI wiring (ADR-003). Loaded by the composition
 * root; the canonical repository is Prisma-backed here, and tests rebind
 * `NewsletterRepository` to `InMemoryNewsletterRepository`. Interfaces only are
 * injected — never a concrete class.
 */
export const newsletterModule = new ContainerModule((bind) => {
  bind<NewsletterRepository>(NEWSLETTER_TYPES.NewsletterRepository).to(PrismaNewsletterRepository);

  bind<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).to(CreateNewsletter);
  bind<GetNewsletter>(NEWSLETTER_TYPES.GetNewsletter).to(GetNewsletter);
  bind<ListNewsletters>(NEWSLETTER_TYPES.ListNewsletters).to(ListNewsletters);
  bind<UpdateNewsletter>(NEWSLETTER_TYPES.UpdateNewsletter).to(UpdateNewsletter);
  bind<DeleteNewsletter>(NEWSLETTER_TYPES.DeleteNewsletter).to(DeleteNewsletter);
});
