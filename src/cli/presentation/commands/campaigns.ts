import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { z } from 'zod';
import type {
  CampaignDto,
  ListEnvelope,
  SendDto,
  RecipientOutcomeDto,
  SubscriptionDto,
} from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { collect, FlagError, paginationFlags, parseFlags } from '../flags.js';
import { pruneUndefined } from './newsletters.js';
import { shortDate, truncate, type Column } from '../output.js';
import { confirmAction, promptText } from '../prompts.js';

/**
 * `/v1/campaigns` — the send integrator. Note what is deliberately absent:
 * there is no `schedule` command, because there are no scheduled campaigns in
 * v1 (sending is on-demand only) and a CLI-side timer would be exactly the
 * in-process scheduler ADR-009 rules out.
 */

const columns: Column<CampaignDto>[] = [
  { header: 'id', value: (c) => c.id },
  { header: 'name', value: (c) => truncate(c.name, 28) },
  { header: 'status', value: (c) => c.status },
  { header: 'recipients', value: (c) => String(c.stats.recipients) },
  { header: 'sent', value: (c) => shortDate(c.sentAt) },
];

export function registerCampaignCommands(program: Command, ctx: () => CommandContext): void {
  const campaigns = program.command('campaigns').description('Manage and send campaigns');

  campaigns
    .command('list', { isDefault: true })
    .description('List campaigns')
    .option('--newsletter <id>', 'only campaigns for this newsletter')
    .option('--status <status>', 'draft | sending | sent | failed')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(
        paginationFlags.extend({
          newsletter: z.string().trim().min(1).optional(),
          status: z.enum(['draft', 'sending', 'sent', 'failed']).optional(),
        }),
        raw,
      );

      const api = await c.api();
      const query = { newsletterId: flags.newsletter, status: flags.status };

      if (flags.all) {
        const data = await api.listAll<CampaignDto>('/v1/campaigns', query);
        c.printer.table({ data, meta: { nextCursor: null } }, columns);
        return;
      }

      const page = await api.get<ListEnvelope<CampaignDto>>('/v1/campaigns', {
        ...query,
        limit: flags.limit,
        cursor: flags.cursor,
      });
      c.printer.table(page, columns);
    });

  campaigns
    .command('get <id>')
    .description('Show one campaign')
    .action(async (id: string) => {
      const c = ctx();
      const api = await c.api();
      const campaign = await api.get<CampaignDto>(`/v1/campaigns/${encodeURIComponent(id)}`);
      c.printer.detail(
        {
          id: campaign.id,
          name: campaign.name,
          newsletterId: campaign.newsletterId,
          status: campaign.status,
          subject: campaign.subject,
          templateId: campaign.templateId,
          segmentTags: campaign.segmentTags,
          recipients: campaign.stats.recipients,
          delivered: campaign.stats.delivered,
          bounced: campaign.stats.bounced,
          complained: campaign.stats.complained,
          sentAt: campaign.sentAt,
        },
        campaign,
      );
    });

  campaigns
    .command('create')
    .description('Create a campaign from a template, or from inline content')
    .option('--newsletter <id>', 'newsletter to send from')
    .option('--name <name>', 'campaign name')
    .option('--template <id>', 'template to render (mutually exclusive with --subject/--html)')
    .option('--subject <subject>', 'subject line, for inline content')
    .option('--html <file>', 'file containing the HTML body, for inline content')
    .option('--text <file>', 'file containing the plain-text body')
    .option('--tag <tag>', 'segment tag: only subscribers with this tag (repeatable)', collect, [])
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          newsletter: z.string().trim().min(1).optional(),
          name: z.string().trim().min(1).max(200).optional(),
          template: z.string().trim().min(1).optional(),
          subject: z.string().trim().min(1).max(998).optional(),
          html: z.string().optional(),
          text: z.string().optional(),
          tag: z.array(z.string().trim().min(1).max(64)).default([]),
        }),
        raw,
      );

      // The API requires exactly one content source; catching it here gives a
      // better message than the server's generic refinement error, and saves a
      // round trip.
      const hasInline = flags.subject !== undefined || flags.html !== undefined;
      if (flags.template !== undefined && hasInline) {
        throw new FlagError('Use either --template or inline --subject/--html, not both.');
      }
      if (flags.template === undefined && !hasInline) {
        throw new FlagError(
          'A campaign needs content: pass --template <id>, or --subject and --html.',
        );
      }

      const newsletterId = await promptText(flags.newsletter, {
        message: 'Newsletter id',
        flag: '--newsletter',
      });
      const name = await promptText(flags.name, { message: 'Campaign name', flag: '--name' });

      const api = await c.api();
      const campaign = await api.post<CampaignDto>('/v1/campaigns', {
        newsletterId,
        name,
        templateId: flags.template,
        subject: flags.subject,
        bodyHtml: flags.html === undefined ? undefined : await readFile(flags.html, 'utf8'),
        bodyText: flags.text === undefined ? undefined : await readFile(flags.text, 'utf8'),
        segmentTags: flags.tag.length > 0 ? flags.tag : undefined,
      });

      c.printer.data(campaign);
      c.printer.success(`Created campaign ${campaign.id} (${campaign.status})`);
    });

  campaigns
    .command('update <id>')
    .description('Update a not-yet-sent campaign')
    .option('--name <name>', 'campaign name')
    .option('--template <id>', 'template to render')
    .option('--subject <subject>', 'subject line')
    .option('--html <file>', 'file containing the HTML body')
    .option('--text <file>', 'file containing the plain-text body')
    .option('--tag <tag>', 'segment tag (repeatable; replaces the existing set)', collect, [])
    .action(async (id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          name: z.string().trim().min(1).max(200).optional(),
          template: z.string().trim().min(1).optional(),
          subject: z.string().trim().min(1).max(998).optional(),
          html: z.string().optional(),
          text: z.string().optional(),
          tag: z.array(z.string().trim().min(1).max(64)).default([]),
        }),
        raw,
      );

      const body = pruneUndefined({
        name: flags.name,
        templateId: flags.template,
        subject: flags.subject,
        bodyHtml: flags.html === undefined ? undefined : await readFile(flags.html, 'utf8'),
        bodyText: flags.text === undefined ? undefined : await readFile(flags.text, 'utf8'),
        segmentTags: flags.tag.length > 0 ? flags.tag : undefined,
      });

      if (Object.keys(body).length === 0) {
        c.printer.warn('Nothing to update — pass at least one field.');
        process.exitCode = 2;
        return;
      }

      const api = await c.api();
      const campaign = await api.patch<CampaignDto>(
        `/v1/campaigns/${encodeURIComponent(id)}`,
        body,
      );
      c.printer.data(campaign);
      c.printer.success(`Updated campaign ${campaign.id}`);
    });

  campaigns
    .command('delete <id>')
    .description('Delete a campaign')
    .action(async (id: string) => {
      const c = ctx();
      await confirmAction(`Delete campaign ${id}?`, c.assumeYes);
      const api = await c.api();
      await api.delete(`/v1/campaigns/${encodeURIComponent(id)}`);
      c.printer.success(`Deleted campaign ${id}`);
    });

  campaigns
    .command('send <id>')
    .description('Send a campaign now — irreversible')
    .option('--dry-run', 'report the recipient count without sending')
    .action(async (id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(z.object({ dryRun: z.boolean().default(false) }), raw);
      const api = await c.api();

      const campaign = await api.get<CampaignDto>(`/v1/campaigns/${encodeURIComponent(id)}`);

      if (campaign.status === 'sent') {
        c.printer.warn(`Campaign ${id} was already sent at ${shortDate(campaign.sentAt)}.`);
        return;
      }

      // Count from the subscriber list, not from campaign.stats — stats are
      // populated *by* the send, so before one they are all zero. This is an
      // estimate, and says so: the server applies the suppression list at send
      // time (ADR-008), which this count cannot see.
      const recipients = await api.listAll<SubscriptionDto>(
        `/v1/newsletters/${encodeURIComponent(campaign.newsletterId)}/subscriptions`,
        { status: 'subscribed' },
      );
      const targeted =
        campaign.segmentTags.length === 0
          ? recipients
          : recipients.filter((s) => campaign.segmentTags.some((tag) => s.tags.includes(tag)));

      if (flags.dryRun) {
        c.printer.data({ campaignId: campaign.id, estimatedRecipients: targeted.length });
        c.printer.success(
          `Dry run: about ${targeted.length} recipient(s) before suppression filtering.`,
        );
        return;
      }

      await confirmAction(
        `Send "${campaign.name}" to about ${targeted.length} recipient(s)? This cannot be undone.`,
        c.assumeYes,
      );

      // An idempotency key makes a retried send safe: if the response is lost
      // in flight, re-running with the same key replays the original result
      // instead of mailing the list twice.
      const sent = await api.post<CampaignDto>(
        `/v1/campaigns/${encodeURIComponent(id)}/send`,
        undefined,
        { idempotencyKey: randomUUID() },
      );

      c.printer.data(sent);
      c.printer.success(
        `Sent "${sent.name}" — ${sent.stats.recipients} recipient(s), ${sent.stats.accepted} accepted.`,
      );
      c.printer.dim(`Per-recipient outcomes arrive by webhook: cablegram campaigns report ${id}`);
    });

  campaigns
    .command('report <id>')
    .description('Show a campaign’s send: live stats + per-recipient outcomes')
    .option('--failures', 'only rejected, bounced or complained recipients')
    .option('--status <status>', 'filter to one outcome status')
    .option('--limit <n>', 'recipients per page (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page of recipients')
    .option('--summary', 'stats only — skip the recipient list entirely')
    .action(async (id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        paginationFlags.extend({
          failures: z.boolean().default(false),
          status: z.string().trim().min(1).optional(),
          summary: z.boolean().default(false),
        }),
        raw,
      );
      const api = await c.api();
      const base = `/v1/campaigns/${encodeURIComponent(id)}`;

      // Two calls now, not one: the send carries submission facts + live stats,
      // and recipients are a separate paginated resource (they are no longer
      // inlined — at 18k that was a multi-megabyte response).
      const send = await api.get<SendDto>(`${base}/send`);

      if (flags.summary) {
        c.printer.data(send);
        c.printer.detail(summaryOf(send));
        return;
      }

      const query = { failuresOnly: flags.failures || undefined, status: flags.status };
      const recipients = flags.all
        ? await api.listAll<RecipientOutcomeDto>(`${base}/send/recipients`, query)
        : (
            await api.get<ListEnvelope<RecipientOutcomeDto>>(`${base}/send/recipients`, {
              ...query,
              limit: flags.limit,
              cursor: flags.cursor,
            })
          ).data;

      if (c.printer.isJson) {
        c.printer.data({ ...send, recipients });
        return;
      }

      c.printer.detail(summaryOf(send));
      c.printer.line();
      c.printer.table({ data: recipients }, [
        { header: 'address', value: (r) => r.address },
        { header: 'status', value: (r) => r.status },
        { header: 'opens', value: (r) => String(r.opens) },
        { header: 'clicks', value: (r) => String(r.clicks) },
      ]);
    });
}

/** The stats block shown above a report. */
function summaryOf(send: SendDto): Record<string, unknown> {
  return {
    campaignId: send.campaignId,
    submittedAt: send.submittedAt,
    recipients: send.stats.recipients,
    accepted: send.stats.accepted,
    rejected: send.stats.rejected,
    delivered: send.stats.delivered,
    bounced: send.stats.bounced,
    complained: send.stats.complained,
  };
}
