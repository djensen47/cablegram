import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { TEMPLATE_TYPES } from '../types.js';
import { Template } from '../domain/template.js';
import type { TemplateRepository } from './template-repository.js';
import type { TemplateRenderer } from './template-renderer.js';
import type { CreateTemplateInput } from './dtos.js';

/**
 * Creates a template: mint an id, build a validated aggregate, confirm the
 * bodies compile against the bound renderer (an empty-model dry run —
 * `TemplateCompileError` on malformed source, ADR-006's "reject at the edge"
 * extended to template syntax), then persist.
 */
@injectable()
export class CreateTemplate {
  constructor(
    @inject(TEMPLATE_TYPES.TemplateRepository)
    private readonly repository: TemplateRepository,
    @inject(TEMPLATE_TYPES.TemplateRenderer)
    private readonly renderer: TemplateRenderer,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: CreateTemplateInput): Promise<Template> {
    const template = Template.create({
      id: newId(),
      name: input.name,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      now: this.clock.now(),
    });

    this.renderer.render(template, {});

    await this.repository.create(template);
    return template;
  }
}
