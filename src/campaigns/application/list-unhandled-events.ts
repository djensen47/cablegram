import { inject, injectable } from 'inversify';
import { CAMPAIGN_TYPES } from '../types.js';
import type {
  UnhandledEventRecord,
  UnhandledEventRepository,
} from './unhandled-event-repository.js';

/**
 * Reads the record of provider events cablegram received but did not act on
 * (ADR-021) — the answer to "is Postmark sending us anything we're dropping?".
 *
 * Deliberately not paginated: the collection is one row per *kind* of event, so
 * it is bounded by Postmark's record-type table, not by traffic.
 */
@injectable()
export class ListUnhandledEvents {
  constructor(
    @inject(CAMPAIGN_TYPES.UnhandledEventRepository)
    private readonly unhandled: UnhandledEventRepository,
  ) {}

  async execute(): Promise<UnhandledEventRecord[]> {
    return this.unhandled.list();
  }
}
