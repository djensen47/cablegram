import { inject, injectable } from 'inversify';
import { DELIVERABILITY_TYPES } from '../types.js';
import type { SuppressionEntry } from '../domain/suppression.js';
import type { SuppressionRepository } from './suppression-repository.js';
import type { ListSuppressionsInput } from './dtos.js';

/**
 * Lists suppression entries for one page. Fetches `limit + 1` rows so the
 * presentation layer can tell whether a next page exists and derive its
 * cursor (`toPage`).
 */
@injectable()
export class ListSuppressions {
  constructor(
    @inject(DELIVERABILITY_TYPES.SuppressionRepository)
    private readonly repository: SuppressionRepository,
  ) {}

  async execute(input: ListSuppressionsInput): Promise<SuppressionEntry[]> {
    return this.repository.list({ limit: input.limit + 1, cursor: input.cursor });
  }
}
