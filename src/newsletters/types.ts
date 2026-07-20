/**
 * DI tokens for the newsletters component (ADR-003). A pure-Symbol leaf that
 * every layer of this component may import; the concrete bindings live in the
 * `ContainerModule` (infrastructure), and tests rebind
 * `NewsletterRepository` to an in-memory double.
 */
export const NEWSLETTER_TYPES = {
  NewsletterRepository: Symbol.for('NewsletterRepository'),
  CreateNewsletter: Symbol.for('CreateNewsletter'),
  GetNewsletter: Symbol.for('GetNewsletter'),
  ListNewsletters: Symbol.for('ListNewsletters'),
  UpdateNewsletter: Symbol.for('UpdateNewsletter'),
  DeleteNewsletter: Symbol.for('DeleteNewsletter'),
} as const;
