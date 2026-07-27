import { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../../application/api-error.js';
import type { ListEnvelope, SuppressionDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { emailFlag, FlagError, paginationFlags, parseFlags } from '../flags.js';
import { shortDate, type Column } from '../output.js';
import { confirmAction } from '../prompts.js';

/**
 * `/v1/suppressions` — the global, address-keyed deny list.
 *
 * This is cablegram's **own** authoritative list, not Postmark's, and it is
 * distinct from a per-newsletter unsubscribe (ADR-015): unsubscribing flips one
 * subscription's status, suppression blocks an address across every newsletter.
 * The commands say so, because conflating them is how someone gets mailed after
 * complaining.
 */

const REASONS = ['hard-bounce', 'spam-complaint', 'manual-junk', 'global-opt-out'] as const;

const columns: Column<SuppressionDto>[] = [
  { header: 'address', value: (s) => s.address },
  { header: 'reason', value: (s) => s.reason },
  { header: 'since', value: (s) => shortDate(s.createdAt) },
];

export function registerSuppressionCommands(program: Command, ctx: () => CommandContext): void {
  const suppressions = program
    .command('suppressions')
    .description('Manage the global suppression (deny) list');

  suppressions
    .command('list', { isDefault: true })
    .description('List suppressed addresses')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(paginationFlags, raw);
      const api = await c.api();

      if (flags.all) {
        const data = await api.listAll<SuppressionDto>('/v1/suppressions');
        c.printer.table({ data, meta: { nextCursor: null } }, columns);
        return;
      }

      const page = await api.get<ListEnvelope<SuppressionDto>>('/v1/suppressions', {
        limit: flags.limit,
        cursor: flags.cursor,
      });
      c.printer.table(page, columns);
    });

  suppressions
    .command('check <address>')
    .description('Check whether an address is suppressed')
    .action(async (address: string) => {
      const c = ctx();
      const api = await c.api();

      try {
        const entry = await api.get<SuppressionDto>(
          `/v1/suppressions/${encodeURIComponent(address)}`,
        );
        c.printer.data(entry);
        c.printer.line(`${entry.address} is suppressed (${entry.reason}, ${shortDate(entry.createdAt)})`);
        // Non-zero so `cablegram suppressions check x || send-to x` composes in
        // a shell: suppressed is the "no" answer, not an error.
        process.exitCode = 1;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          c.printer.data({ address, suppressed: false });
          c.printer.line(`${address} is not suppressed`);
          return;
        }
        throw err;
      }
    });

  suppressions
    .command('add <address>')
    .description('Suppress an address across every newsletter')
    .option('--reason <reason>', `one of: ${REASONS.join(', ')}`, 'manual-junk')
    .action(async (address: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({ reason: z.enum(REASONS).default('manual-junk') }),
        raw,
      );
      const parsed = emailFlag.safeParse(address);
      if (!parsed.success) {
        throw new FlagError(`"${address}" is not a valid email address.`);
      }

      const api = await c.api();
      const entry = await api.post<SuppressionDto>('/v1/suppressions', {
        address: parsed.data,
        reason: flags.reason,
      });

      c.printer.data(entry);
      c.printer.success(`Suppressed ${entry.address} (${entry.reason}) across all newsletters.`);
    });

  suppressions
    .command('remove <address>')
    .description('Remove an address from the suppression list')
    .action(async (address: string) => {
      const c = ctx();
      await confirmAction(
        `Un-suppress ${address}? They will be eligible to receive mail again.`,
        c.assumeYes,
      );
      const api = await c.api();
      await api.delete(`/v1/suppressions/${encodeURIComponent(address)}`);
      c.printer.success(`Removed ${address} from the suppression list.`);
    });
}
