import { Command } from 'commander';
import type { UnhandledEventDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { shortDate, truncate, type Column } from '../output.js';

/**
 * `/v1/webhooks` — the operator's view of the Postmark receiver.
 *
 * The receiver itself always answers 200 (a non-200 makes Postmark retry for
 * hours), which used to mean an event cablegram did not recognize left no trace
 * at all. This is where those now surface: one row per *kind* of unrecognized
 * event, so the answer to "is Postmark sending us anything we're dropping?" is
 * a command rather than an archaeology project through activation logs.
 */

const columns: Column<UnhandledEventDto>[] = [
  { header: 'type', value: (e) => e.key },
  { header: 'count', value: (e) => String(e.count) },
  { header: 'first seen', value: (e) => shortDate(e.firstSeenAt) },
  { header: 'last seen', value: (e) => shortDate(e.lastSeenAt) },
];

export function registerWebhookCommands(program: Command, ctx: () => CommandContext): void {
  const webhooks = program.command('webhooks').description('Inspect the provider webhook receiver');

  webhooks
    .command('unhandled', { isDefault: true })
    .description('List provider events the receiver accepted but did not act on')
    .option('--samples', 'also print the first payload seen for each type')
    .action(async (raw: { samples?: boolean }) => {
      const c = ctx();
      const api = await c.api();

      // Not paginated, and deliberately so: the collection holds one row per
      // kind of event, not one per event.
      const page = await api.get<{ data: UnhandledEventDto[] }>('/v1/webhooks/unhandled');
      c.printer.table(page, columns);

      if (raw.samples === true && !c.printer.isJson) {
        for (const event of page.data) {
          c.printer.line();
          c.printer.line(`${event.key}:`);
          c.printer.line(`  ${truncate(event.sample, 200)}`);
        }
      }

      if (page.data.length > 0) {
        c.printer.warn(
          `${page.data.length} unhandled event type(s). Each one is mail traffic cablegram is ` +
            'receiving and discarding.',
        );
      }
    });
}
