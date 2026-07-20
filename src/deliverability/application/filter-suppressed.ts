import { inject, injectable } from 'inversify';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { DELIVERABILITY_TYPES } from '../types.js';
import type { SuppressionRepository } from './suppression-repository.js';

/**
 * The send-path gate (ADR-011): given a batch of addresses, returns the subset
 * that is currently suppressed, so `campaigns` can exclude them before calling
 * `email.send()`. Normalizes every address first so callers may pass raw
 * subscription addresses straight through.
 */
@injectable()
export class FilterSuppressed {
  constructor(
    @inject(DELIVERABILITY_TYPES.SuppressionRepository)
    private readonly repository: SuppressionRepository,
  ) {}

  async execute(addresses: string[]): Promise<string[]> {
    return this.repository.filterSuppressed(addresses.map(normalizeEmailAddress));
  }
}
