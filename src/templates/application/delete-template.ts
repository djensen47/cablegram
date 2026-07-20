import { inject, injectable } from 'inversify';
import { TEMPLATE_TYPES } from '../types.js';
import type { TemplateId } from '../domain/template.js';
import { TemplateNotFoundError } from '../domain/errors.js';
import type { TemplateRepository } from './template-repository.js';

/** Deletes a template by id, or throws `TemplateNotFoundError` if absent. */
@injectable()
export class DeleteTemplate {
  constructor(
    @inject(TEMPLATE_TYPES.TemplateRepository)
    private readonly repository: TemplateRepository,
  ) {}

  async execute(id: TemplateId): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      throw new TemplateNotFoundError(id);
    }
  }
}
