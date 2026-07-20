import { inject, injectable } from 'inversify';
import { AddSuppression, DELIVERABILITY_TYPES, FilterSuppressed } from '../../deliverability/index.js';
import type { SuppressionSignal } from '../domain/send-record.js';
import type { SuppressionGateway } from '../application/suppression-gateway.js';

/**
 * The adapter fulfilling the `SuppressionGateway` port over the `deliverability`
 * facade (ADR-005 #3 + the ADR-011 DAG edge `campaigns → deliverability`). It
 * fronts both send-path gate 2 (`FilterSuppressed`) and the webhook-driven
 * suppression writes (`AddSuppression`, idempotent). The signal's reason
 * (`hard-bounce` / `spam-complaint`) is a member of deliverability's reason
 * taxonomy, so it passes straight through.
 */
@injectable()
export class FacadeSuppressionGateway implements SuppressionGateway {
  constructor(
    @inject(DELIVERABILITY_TYPES.FilterSuppressed)
    private readonly filter: FilterSuppressed,
    @inject(DELIVERABILITY_TYPES.AddSuppression)
    private readonly add: AddSuppression,
  ) {}

  async filterSuppressed(addresses: readonly string[]): Promise<string[]> {
    return this.filter.execute([...addresses]);
  }

  async suppress(signal: SuppressionSignal): Promise<void> {
    await this.add.execute({ address: signal.address, reason: signal.reason });
  }
}
