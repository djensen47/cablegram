import { inject, injectable } from 'inversify';
import { TEMPLATE_TYPES } from '../types.js';
import type { Template } from '../domain/template.js';
import type { TemplateRepository } from './template-repository.js';
import type { ListTemplatesInput } from './dtos.js';

/**
 * Lists templates for one page. Fetches `limit + 1` rows so the presentation
 * layer can tell whether a next page exists and derive its cursor (`toPage`).
 */
@injectable()
export class ListTemplates {
  constructor(
    @inject(TEMPLATE_TYPES.TemplateRepository)
    private readonly repository: TemplateRepository,
  ) {}

  async execute(input: ListTemplatesInput): Promise<Template[]> {
    return this.repository.list({ limit: input.limit + 1, cursor: input.cursor });
  }
}
