/**
 * DI tokens for the templates component (ADR-003). A pure-Symbol leaf that
 * every layer of this component may import; the concrete bindings live in the
 * `ContainerModule` (infrastructure), and tests rebind `TemplateRepository`
 * to an in-memory double.
 */
export const TEMPLATE_TYPES = {
  TemplateRepository: Symbol.for('TemplateRepository'),
  TemplateRenderer: Symbol.for('TemplateRenderer'),
  CreateTemplate: Symbol.for('CreateTemplate'),
  GetTemplate: Symbol.for('GetTemplate'),
  ListTemplates: Symbol.for('ListTemplates'),
  UpdateTemplate: Symbol.for('UpdateTemplate'),
  DeleteTemplate: Symbol.for('DeleteTemplate'),
} as const;
