// Facade for the templates component (ADR-002/005): import only from here.
// Everything below is the component's public surface; internals are reached
// only through these exports.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { templateModule } from './infrastructure/module.js';
export { TEMPLATE_TYPES } from './types.js';

// HTTP router (mounted onto /v1 by the app assembly).
export { createTemplateRoutes } from './presentation/routes.js';

// In-memory repository: the DI-rebind test double (ADR-003).
export { InMemoryTemplateRepository } from './infrastructure/in-memory-template-repository.js';

// Domain + application contracts consumers may need to type against.
export { Template, type TemplateId } from './domain/template.js';
export {
  TemplateError,
  InvalidTemplateError,
  TemplateNotFoundError,
  TemplateCompileError,
} from './domain/errors.js';
export type {
  TemplateRepository,
  ListTemplatesOptions,
} from './application/template-repository.js';
export type { TemplateRenderer, RenderedTemplate } from './application/template-renderer.js';
export type {
  CreateTemplateInput,
  UpdateTemplateInput,
  ListTemplatesInput,
} from './application/dtos.js';

// Use case classes (resolved from the container by token; typed here for tests).
export { CreateTemplate } from './application/create-template.js';
export { GetTemplate } from './application/get-template.js';
export { ListTemplates } from './application/list-templates.js';
export { UpdateTemplate } from './application/update-template.js';
export { DeleteTemplate } from './application/delete-template.js';
