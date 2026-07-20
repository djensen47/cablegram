import { inject, injectable } from 'inversify';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { DELIVERABILITY_TYPES } from '../types.js';
import { SuppressionNotFoundError } from '../domain/errors.js';
import type { SuppressionRepository } from './suppression-repository.js';

/** Removes an address from the suppression list, or throws if it is not there. */
@injectable()
export class RemoveSuppression {
  constructor(
    @inject(DELIVERABILITY_TYPES.SuppressionRepository)
    private readonly repository: SuppressionRepository,
  ) {}

  async execute(address: string): Promise<void> {
    const removed = await this.repository.remove(normalizeEmailAddress(address));
    if (!removed) {
      throw new SuppressionNotFoundError(address);
    }
  }
}
