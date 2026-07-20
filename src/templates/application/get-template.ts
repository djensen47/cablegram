import { inject, injectable } from 'inversify';
import { TEMPLATE_TYPES } from '../types.js';
import { Template, type TemplateId } from '../domain/template.js';
import { TemplateNotFoundError } from '../domain/errors.js';
import type { TemplateRepository } from './template-repository.js';

/** Fetches one template by id, or throws `TemplateNotFoundError`. */
@injectable()
export class GetTemplate {
  constructor(
    @inject(TEMPLATE_TYPES.TemplateRepository)
    private readonly repository: TemplateRepository,
  ) {}

  async execute(id: TemplateId): Promise<Template> {
    const template = await this.repository.findById(id);
    if (template === null) {
      throw new TemplateNotFoundError(id);
    }
    return template;
  }
}
