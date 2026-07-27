import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { DELIVERABILITY_TYPES } from '../types.js';
import { SuppressionEntry } from '../domain/suppression.js';
import type { SuppressionRepository } from './suppression-repository.js';
import type { AddSuppressionsInput } from './dtos.js';

/**
 * Adds many addresses to the global suppression list in one write batch — the
 * bulk form of `AddSuppression`, with identical semantics per address.
 *
 * It exists for the subscriber import (ADR-022): a list migrated off another
 * ESP arrives with its hard bounces already known, and those are mailbox facts
 * that belong on the global list before the first campaign goes out. Doing that
 * one HTTP-less round trip per address would make the import's cost scale with
 * the number of dead mailboxes rather than with the file.
 *
 * Idempotent (ADR-011): an address already suppressed keeps its original reason
 * and timestamp. Addresses that fail validation are **dropped, not thrown** —
 * this is a hygiene side effect of a bulk operation, and one malformed address
 * must not fail an otherwise good batch of 500 subscribers. Returns how many
 * entries were submitted so the caller can report it.
 */
@injectable()
export class AddSuppressions {
  constructor(
    @inject(DELIVERABILITY_TYPES.SuppressionRepository)
    private readonly repository: SuppressionRepository,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: AddSuppressionsInput): Promise<number> {
    const now = this.clock.now();
    const entries: SuppressionEntry[] = [];

    for (const address of input.addresses) {
      try {
        entries.push(SuppressionEntry.create({ address, reason: input.reason, now }));
      } catch {
        // An unparseable address cannot be suppressed and cannot be sent to
        // either — dropping it is the outcome the caller wanted regardless.
        continue;
      }
    }

    await this.repository.addMany(entries);
    return entries.length;
  }
}
