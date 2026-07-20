import { ContainerModule } from 'inversify';
import { TEMPLATE_TYPES } from '../types.js';
import type { TemplateRepository } from '../application/template-repository.js';
import type { TemplateRenderer } from '../application/template-renderer.js';
import { CreateTemplate } from '../application/create-template.js';
import { GetTemplate } from '../application/get-template.js';
import { ListTemplates } from '../application/list-templates.js';
import { UpdateTemplate } from '../application/update-template.js';
import { DeleteTemplate } from '../application/delete-template.js';
import { PrismaTemplateRepository } from './prisma-template-repository.js';
import { HandlebarsTemplateRenderer } from './handlebars-template-renderer.js';

/**
 * The templates component's DI wiring (ADR-003). Loaded by the composition
 * root; the canonical repository is Prisma-backed here and the canonical
 * renderer is the Handlebars implementation. Tests rebind `TemplateRepository`
 * to `InMemoryTemplateRepository`. Interfaces only are injected — never a
 * concrete class.
 */
export const templateModule = new ContainerModule((bind) => {
  bind<TemplateRepository>(TEMPLATE_TYPES.TemplateRepository).to(PrismaTemplateRepository);
  bind<TemplateRenderer>(TEMPLATE_TYPES.TemplateRenderer).to(HandlebarsTemplateRenderer);

  bind<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate).to(CreateTemplate);
  bind<GetTemplate>(TEMPLATE_TYPES.GetTemplate).to(GetTemplate);
  bind<ListTemplates>(TEMPLATE_TYPES.ListTemplates).to(ListTemplates);
  bind<UpdateTemplate>(TEMPLATE_TYPES.UpdateTemplate).to(UpdateTemplate);
  bind<DeleteTemplate>(TEMPLATE_TYPES.DeleteTemplate).to(DeleteTemplate);
});
