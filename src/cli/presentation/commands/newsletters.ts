import { Command } from 'commander';
import { z } from 'zod';
import type { ListEnvelope, NewsletterDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { emailFlag, paginationFlags, parseFlags } from '../flags.js';
import { shortDate, truncate, type Column } from '../output.js';
import { confirmAction, promptText } from '../prompts.js';

/** `/v1/newsletters` — the publications a campaign is sent from. */

const columns: Column<NewsletterDto>[] = [
  { header: 'id', value: (n) => n.id },
  { header: 'name', value: (n) => truncate(n.name, 32) },
  { header: 'from', value: (n) => `${n.fromName} <${n.fromEmail}>` },
  { header: 'created', value: (n) => shortDate(n.createdAt) },
];

/**
 * `--reply-to`, `--sending-domain` and `--dkim-identifier` are nullable on the
 * API, and the string `"null"` is how a CLI expresses "clear this" — an absent
 * flag means "leave unchanged", which is a different thing and must stay so.
 */
const nullableString = z
  .string()
  .optional()
  .transform((v) => (v === 'null' ? null : v));

export function registerNewsletterCommands(program: Command, ctx: () => CommandContext): void {
  const newsletters = program.command('newsletters').description('Manage newsletters');

  newsletters
    .command('list', { isDefault: true })
    .description('List newsletters')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(paginationFlags, raw);
      const api = await c.api();

      if (flags.all) {
        const data = await api.listAll<NewsletterDto>('/v1/newsletters');
        c.printer.table({ data, meta: { nextCursor: null } }, columns);
        return;
      }

      const page = await api.get<ListEnvelope<NewsletterDto>>('/v1/newsletters', {
        limit: flags.limit,
        cursor: flags.cursor,
      });
      c.printer.table(page, columns);
    });

  newsletters
    .command('get <id>')
    .description('Show one newsletter')
    .action(async (id: string) => {
      const c = ctx();
      const api = await c.api();
      const newsletter = await api.get<NewsletterDto>(`/v1/newsletters/${encodeURIComponent(id)}`);
      c.printer.detail({ ...newsletter }, newsletter);
    });

  newsletters
    .command('create')
    .description('Create a newsletter')
    .option('--name <name>', 'display name')
    .option('--from-name <name>', 'sender display name')
    .option('--from-email <email>', 'sender address (must be Postmark-verified)')
    .option('--reply-to <email>', 'reply-to address')
    .option('--sending-domain <domain>', 'sending domain')
    .option('--dkim-identifier <id>', 'DKIM identifier')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          name: z.string().trim().min(1).max(200).optional(),
          fromName: z.string().trim().min(1).max(200).optional(),
          fromEmail: emailFlag.optional(),
          replyTo: emailFlag.optional(),
          sendingDomain: z.string().trim().max(253).optional(),
          dkimIdentifier: z.string().trim().max(64).optional(),
        }),
        raw,
      );

      const name = await promptText(flags.name, { message: 'Newsletter name', flag: '--name' });
      const fromName = await promptText(flags.fromName, {
        message: 'Sender name',
        flag: '--from-name',
        initialValue: name,
      });
      const fromEmail = await promptText(flags.fromEmail, {
        message: 'Sender email',
        flag: '--from-email',
        validate: (v) => (emailFlag.safeParse(v).success ? undefined : 'Not a valid email address.'),
      });

      const api = await c.api();
      const newsletter = await api.post<NewsletterDto>('/v1/newsletters', {
        name,
        fromName,
        fromEmail,
        replyTo: flags.replyTo,
        sendingDomain: flags.sendingDomain,
        dkimIdentifier: flags.dkimIdentifier,
      });

      c.printer.data(newsletter);
      c.printer.success(`Created newsletter ${newsletter.id}`);
    });

  newsletters
    .command('update <id>')
    .description('Update a newsletter (pass "null" to clear an optional field)')
    .option('--name <name>', 'display name')
    .option('--from-name <name>', 'sender display name')
    .option('--from-email <email>', 'sender address')
    .option('--reply-to <email>', 'reply-to address, or "null" to clear')
    .option('--sending-domain <domain>', 'sending domain, or "null" to clear')
    .option('--dkim-identifier <id>', 'DKIM identifier, or "null" to clear')
    .action(async (id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          name: z.string().trim().min(1).max(200).optional(),
          fromName: z.string().trim().min(1).max(200).optional(),
          fromEmail: emailFlag.optional(),
          replyTo: nullableString,
          sendingDomain: nullableString,
          dkimIdentifier: nullableString,
        }),
        raw,
      );

      const body = pruneUndefined(flags);
      if (Object.keys(body).length === 0) {
        c.printer.warn('Nothing to update — pass at least one field.');
        process.exitCode = 2;
        return;
      }

      const api = await c.api();
      const newsletter = await api.patch<NewsletterDto>(
        `/v1/newsletters/${encodeURIComponent(id)}`,
        body,
      );
      c.printer.data(newsletter);
      c.printer.success(`Updated newsletter ${newsletter.id}`);
    });

  newsletters
    .command('delete <id>')
    .description('Delete a newsletter')
    .action(async (id: string) => {
      const c = ctx();
      await confirmAction(`Delete newsletter ${id}?`, c.assumeYes);
      const api = await c.api();
      await api.delete(`/v1/newsletters/${encodeURIComponent(id)}`);
      c.printer.success(`Deleted newsletter ${id}`);
    });
}

/**
 * Drops keys the operator did not pass, so a PATCH only carries fields that
 * were actually named. `null` survives — it is the explicit "clear this" value.
 */
export function pruneUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}
