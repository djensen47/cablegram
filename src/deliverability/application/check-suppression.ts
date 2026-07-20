import { inject, injectable } from 'inversify';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { DELIVERABILITY_TYPES } from '../types.js';
import type { SuppressionEntry } from '../domain/suppression.js';
import type { SuppressionRepository } from './suppression-repository.js';

/** Looks up a single address's suppression entry, or `null` if it is not suppressed. */
@injectable()
export class CheckSuppression {
  constructor(
    @inject(DELIVERABILITY_TYPES.SuppressionRepository)
    private readonly repository: SuppressionRepository,
  ) {}

  async execute(address: string): Promise<SuppressionEntry | null> {
    return this.repository.findByAddress(normalizeEmailAddress(address));
  }
}
