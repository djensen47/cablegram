import { Command } from 'commander';
import { z } from 'zod';
import type { ListEnvelope, NewsletterDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { FlagError, emailFlag, paginationFlags, parseFlags } from '../flags.js';
import { shortDate, truncate, type Column } from '../output.js';
import { confirmAction, promptText } from '../prompts.js';

/** `/v1/newsletters` — the publications a campaign is sent from. */

const columns: Column<NewsletterDto>[] = [
  { header: 'id', value: (n) => n.id },
  { header: 'name', value: (n) => truncate(n.name, 32) },
  { header: 'from', value: (n) => `${n.fromName} <${n.fromEmail}>` },
  // A missing channel stops a send (campaign) or a double opt-in signup
  // (confirmation), so both are shown rather than left to be discovered.
  { header: 'campaign channel', value: (n) => n.campaignChannel ?? '(not set)' },
  { header: 'confirmation channel', value: (n) => n.confirmationChannel ?? '(not set)' },
  { header: 'opt-in', value: (n) => (n.doubleOptIn ? 'double' : 'single') },
  { header: 'created', value: (n) => shortDate(n.createdAt) },
];

/**
 * The channel flags mirror the API's check (no whitespace, 1-100 chars). Both
 * channels are required, so unlike the optional fields below they have no
 * `"null"` form: the literal is refused rather than sent as a stream ID.
 */
const channelFlag = z
  .string()
  .trim()
  .regex(/^\S{1,100}$/, 'must be 1-100 characters with no whitespace')
  .refine((v) => v !== 'null', 'cannot be cleared; a newsletter without one cannot send');

/**
 * `--sending-channel` is `--campaign-channel`'s 3.1.0 name, still accepted
 * (ADR-031). Either works; both with different values is refused, not guessed.
 */
function campaignChannelOf(flags: { campaignChannel?: string; sendingChannel?: string }): string | undefined {
  const { campaignChannel, sendingChannel } = flags;
  if (campaignChannel !== undefined && sendingChannel !== undefined && campaignChannel !== sendingChannel) {
    throw new FlagError(
      '--campaign-channel and --sending-channel (its deprecated alias) disagree; pass only --campaign-channel',
    );
  }
  return campaignChannel ?? sendingChannel;
}

const CAMPAIGN_CHANNEL_HELP = 'provider channel for campaigns (Postmark Broadcasts stream ID)';
const CONFIRMATION_CHANNEL_HELP =
  'provider channel for subscription confirmations (Postmark Transactional stream ID)';
const SENDING_CHANNEL_HELP = 'deprecated alias for --campaign-channel';
const DOUBLE_OPT_IN_HELP = 'signups must confirm by email (default: single opt-in)';
const SINGLE_OPT_IN_HELP = 'signups are subscribed immediately (the default)';

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
    .option('--campaign-channel <id>', CAMPAIGN_CHANNEL_HELP)
    .option('--confirmation-channel <id>', CONFIRMATION_CHANNEL_HELP)
    .option('--sending-channel <id>', SENDING_CHANNEL_HELP)
    .option('--double-opt-in', DOUBLE_OPT_IN_HELP)
    .option('--no-double-opt-in', SINGLE_OPT_IN_HELP)
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
          campaignChannel: channelFlag.optional(),
          confirmationChannel: channelFlag.optional(),
          sendingChannel: channelFlag.optional(),
          doubleOptIn: z.boolean().optional(),
        }),
        raw,
      );
      const givenCampaignChannel = campaignChannelOf(flags);

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
      const campaignChannel = await promptText(givenCampaignChannel, {
        message: 'Campaign channel (Postmark Broadcasts stream ID)',
        flag: '--campaign-channel',
        validate: (v) => channelFlag.safeParse(v).error?.issues[0]?.message,
      });
      const confirmationChannel = await promptText(flags.confirmationChannel, {
        message: 'Confirmation channel (Postmark Transactional stream ID)',
        flag: '--confirmation-channel',
        validate: (v) => channelFlag.safeParse(v).error?.issues[0]?.message,
      });

      const api = await c.api();
      const newsletter = await api.post<NewsletterDto>('/v1/newsletters', {
        name,
        fromName,
        fromEmail,
        replyTo: flags.replyTo,
        sendingDomain: flags.sendingDomain,
        dkimIdentifier: flags.dkimIdentifier,
        campaignChannel,
        confirmationChannel,
        doubleOptIn: flags.doubleOptIn,
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
    .option('--campaign-channel <id>', `${CAMPAIGN_CHANNEL_HELP}; cannot be cleared`)
    .option('--confirmation-channel <id>', `${CONFIRMATION_CHANNEL_HELP}; cannot be cleared`)
    .option('--sending-channel <id>', SENDING_CHANNEL_HELP)
    .option('--double-opt-in', DOUBLE_OPT_IN_HELP)
    .option('--no-double-opt-in', SINGLE_OPT_IN_HELP)
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
          campaignChannel: channelFlag.optional(),
          confirmationChannel: channelFlag.optional(),
          sendingChannel: channelFlag.optional(),
          doubleOptIn: z.boolean().optional(),
        }),
        raw,
      );
      const { sendingChannel: _alias, ...named } = flags;
      void _alias;
      const body = pruneUndefined({ ...named, campaignChannel: campaignChannelOf(flags) });
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
