import { inject, injectable } from 'inversify';
import { AddSuppressions, DELIVERABILITY_TYPES } from '../../deliverability/index.js';
import type { SuppressionGateway } from '../application/suppression-gateway.js';

/**
 * The adapter fulfilling the `SuppressionGateway` port over the `deliverability`
 * facade (ADR-005 #3 + the DAG edge `subscriptions → deliverability`, added by
 * ADR-022). The reason is pinned to `hard-bounce` here rather than passed in:
 * this port exists for exactly one signal, and leaving the taxonomy open would
 * make it possible to route a complaint onto the global list — the one thing
 * ADR-018 forbids.
 */
@injectable()
export class FacadeSuppressionGateway implements SuppressionGateway {
  constructor(
    @inject(DELIVERABILITY_TYPES.AddSuppressions)
    private readonly addMany: AddSuppressions,
  ) {}

  async suppressHardBounced(addresses: readonly string[]): Promise<void> {
    if (addresses.length === 0) return;
    await this.addMany.execute({ addresses, reason: 'hard-bounce' });
  }
}
