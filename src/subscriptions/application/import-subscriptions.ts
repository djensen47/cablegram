import { inject, injectable } from 'inversify';
import { newId } from '../../shared/ids/index.js';
import { normalizeEmailAddress } from '../../shared/email-address/index.js';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { Clock } from '../../shared/clock/index.js';
import { SUBSCRIPTION_TYPES } from '../types.js';
import {
  SUBSCRIPTION_STATUSES,
  Subscription,
  type SubscriptionStatus,
} from '../domain/subscription.js';
import { SubscriptionNewsletterNotFoundError } from '../domain/errors.js';
import type { SubscriptionRepository } from './subscription-repository.js';
import type { NewsletterDirectory } from './newsletter-directory.js';
import type { SuppressionGateway } from './suppression-gateway.js';
import type {
  ImportSubscriptionRow,
  ImportSubscriptionsInput,
  ImportSubscriptionsResult,
} from './dtos.js';

function emptyBreakdown(): Record<SubscriptionStatus, number> {
  return Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, 0])) as Record<
    SubscriptionStatus,
    number
  >;
}

/**
 * Restore a batch of memberships from another system (ADR-022).
 *
 * **This is not `Subscribe`, and the difference is the reason it exists.**
 * `Subscribe` derives a status from an opt-in toggle, so it can only ever
 * produce `pending` or `subscribed` — which makes it structurally unable to
 * carry a migration, where the incoming list already contains people who
 * unsubscribed, hard-bounced or filed a spam complaint. Running those rows
 * through `Subscribe` would mail people who explicitly opted out: a compliance
 * failure, not a data-quality one, and a way to burn a brand-new sending
 * domain's reputation on the very first campaign.
 *
 * Consequences of that distinction, all deliberate:
 *
 *  - **No mail is ever sent** — not even for `pending` rows. An import restores
 *    consent that already exists; it does not seek new consent, so there is
 *    nothing to confirm. This use case has no `DeliveryGateway` at all, which
 *    is the strongest possible statement of that.
 *  - **The status is taken verbatim** from the row (or the batch's
 *    `defaultStatus`), never derived.
 *  - **The original opt-in date is preserved** as `createdAt` — that timestamp
 *    is the consent record, and losing it destroys the thing you most need if
 *    consent is ever challenged.
 *  - **An imported `bounced` also goes on the global suppression list**, because
 *    a dead mailbox is a fact about the address rather than about this
 *    newsletter (ADR-018). An imported `complained` never does.
 *
 * Batched on purpose: one call resolves every address in the batch with a single
 * read and writes them with a single bulk write, so an 18k-row migration is ~36
 * requests instead of 18,000. Re-running is safe — see `ImportConflictMode`.
 */
@injectable()
export class ImportSubscriptions {
  constructor(
    @inject(SUBSCRIPTION_TYPES.SubscriptionRepository)
    private readonly repository: SubscriptionRepository,
    @inject(SUBSCRIPTION_TYPES.NewsletterDirectory)
    private readonly newsletters: NewsletterDirectory,
    @inject(SUBSCRIPTION_TYPES.SuppressionGateway)
    private readonly suppression: SuppressionGateway,
    @inject(SHARED_TYPES.Clock) private readonly clock: Clock,
  ) {}

  async execute(input: ImportSubscriptionsInput): Promise<ImportSubscriptionsResult> {
    const newsletter = await this.newsletters.find(input.newsletterId);
    if (newsletter === null) {
      throw new SubscriptionNewsletterNotFoundError(input.newsletterId);
    }

    const onConflict = input.onConflict ?? 'skip';
    const defaultStatus = input.defaultStatus ?? 'subscribed';
    const now = this.clock.now();
    const result: ImportSubscriptionsResult = {
      received: input.rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      suppressed: 0,
      byStatus: emptyBreakdown(),
    };

    // Repeats of one address inside a single batch: the first wins and the rest
    // are skipped, which is what a row-at-a-time import would have produced.
    const rows = new Map<string, ImportSubscriptionRow>();
    for (const row of input.rows) {
      const email = normalizeEmailAddress(row.email);
      if (rows.has(email)) {
        result.skipped += 1;
        continue;
      }
      rows.set(email, row);
    }

    // One read for the whole batch (the `(newsletterId, email)` index), rather
    // than a point lookup per row.
    const existing = new Map(
      (await this.repository.findByNewsletterAndEmails(input.newsletterId, [...rows.keys()])).map(
        (subscription) => [subscription.email, subscription],
      ),
    );

    const toWrite: Subscription[] = [];
    const hardBounced: string[] = [];

    for (const [email, row] of rows) {
      const status = row.status ?? defaultStatus;

      // Suppression is decided by the **file**, not by whether the membership
      // row was written: `onConflict` governs this newsletter's row, while a
      // dead mailbox is a fact about the address that every newsletter shares
      // (ADR-018). Skipping a row we already have does not make its mailbox any
      // less dead — and the whole point of importing bounces is to keep the
      // first campaign off them.
      if (status === 'bounced') hardBounced.push(email);

      const found = existing.get(email);
      if (found !== undefined) {
        if (onConflict === 'skip') {
          result.skipped += 1;
          continue;
        }
        found.overwriteFromImport({
          status,
          mergeFields: row.mergeFields,
          tags: row.tags,
          subscribedAt: row.subscribedAt,
          now,
        });
        toWrite.push(found);
        result.updated += 1;
        result.byStatus[status] += 1;
        continue;
      }

      toWrite.push(
        Subscription.import({
          id: newId(),
          newsletterId: input.newsletterId,
          email,
          status,
          mergeFields: row.mergeFields,
          tags: row.tags,
          subscribedAt: row.subscribedAt,
          now,
        }),
      );
      result.created += 1;
      result.byStatus[status] += 1;
    }

    await this.repository.saveMany(toWrite);

    // After the memberships, so a failed batch has not already claimed a global
    // fact about addresses it never stored.
    if (hardBounced.length > 0) {
      await this.suppression.suppressHardBounced(hardBounced);
      result.suppressed = hardBounced.length;
    }

    return result;
  }
}
