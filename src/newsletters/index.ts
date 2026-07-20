// Facade for the newsletters component (ADR-002/005): import only from here.
// Everything below is the component's public surface; internals are reached
// only through these exports.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { newsletterModule } from './infrastructure/module.js';
export { NEWSLETTER_TYPES } from './types.js';

// HTTP router (mounted onto /v1 by the app assembly).
export { createNewsletterRoutes } from './presentation/routes.js';

// In-memory repository: the DI-rebind test double (ADR-003).
export { InMemoryNewsletterRepository } from './infrastructure/in-memory-newsletter-repository.js';

// Domain + application contracts consumers may need to type against.
export { Newsletter, EmailAddress, type NewsletterId } from './domain/newsletter.js';
export {
  NewsletterError,
  InvalidEmailAddressError,
  InvalidNewsletterError,
  NewsletterNotFoundError,
} from './domain/errors.js';
export type {
  NewsletterRepository,
  ListNewslettersOptions,
} from './application/newsletter-repository.js';
export type {
  CreateNewsletterInput,
  UpdateNewsletterInput,
  ListNewslettersInput,
} from './application/dtos.js';

// Use case classes (resolved from the container by token; typed here for tests).
export { CreateNewsletter } from './application/create-newsletter.js';
export { GetNewsletter } from './application/get-newsletter.js';
export { ListNewsletters } from './application/list-newsletters.js';
export { UpdateNewsletter } from './application/update-newsletter.js';
export { DeleteNewsletter } from './application/delete-newsletter.js';
