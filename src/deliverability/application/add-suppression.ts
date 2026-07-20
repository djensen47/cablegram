import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { DELIVERABILITY_TYPES } from '../types.js';
import { SuppressionEntry } from '../domain/suppression.js';
import type { SuppressionRepository } from './suppression-repository.js';
import type { AddSuppressionInput } from './dtos.js';

/**
 * Adds an address to the global suppression list. Idempotent (ADR-011): if the
 * address is already suppressed, the repository leaves the existing entry
 * untouched and this returns it — a duplicate hard-bounce/complaint event
 * never overwrites the original reason/timestamp.
 */
@injectable()
export class AddSuppression {
  constructor(
    @inject(DELIVERABILITY_TYPES.SuppressionRepository)
    private readonly repository: SuppressionRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: AddSuppressionInput): Promise<SuppressionEntry> {
    const entry = SuppressionEntry.create({
      address: input.address,
      reason: input.reason,
      now: this.clock.now(),
    });

    return this.repository.add(entry);
  }
}
