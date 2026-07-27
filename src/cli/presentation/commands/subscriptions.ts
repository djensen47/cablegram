import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../../application/api-error.js';
import type { ListEnvelope, SubscriptionDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { collect, emailFlag, FlagError, paginationFlags, parseFlags, parseKeyValue } from '../flags.js';
import { column, parseCsv } from '../csv.js';
import { shortDate, type Column } from '../output.js';
import { confirmAction, promptText } from '../prompts.js';

/**
 * `/v1/newsletters/{newsletterId}/subscriptions` — flat, per-newsletter
 * membership. Every command takes a newsletter id first because there is no
 * cross-newsletter contact identity (ADR-011): the same address in two
 * newsletters is two independent records.
 */

const columns: Column<SubscriptionDto>[] = [
  { header: 'id', value: (s) => s.id },
  { header: 'email', value: (s) => s.email },
  { header: 'status', value: (s) => s.status },
  { header: 'tags', value: (s) => (s.tags.length > 0 ? s.tags.join(',') : '—') },
  { header: 'created', value: (s) => shortDate(s.createdAt) },
];

const basePath = (newsletterId: string): string =>
  `/v1/newsletters/${encodeURIComponent(newsletterId)}/subscriptions`;

export function registerSubscriptionCommands(program: Command, ctx: () => CommandContext): void {
  const subs = program
    .command('subscriptions')
    .alias('subs')
    .description('Manage per-newsletter subscriptions');

  subs
    .command('list <newsletterId>', { isDefault: true })
    .description('List a newsletter’s subscriptions')
    .option('--status <status>', 'pending | subscribed | unsubscribed')
    .option('--tag <tag>', 'only subscriptions carrying this tag')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (newsletterId: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        paginationFlags.extend({
          status: z.enum(['pending', 'subscribed', 'unsubscribed']).optional(),
          tag: z.string().trim().min(1).max(64).optional(),
        }),
        raw,
      );

      const api = await c.api();
      const query = { status: flags.status, tag: flags.tag };

      if (flags.all) {
        const data = await api.listAll<SubscriptionDto>(basePath(newsletterId), query);
        c.printer.table({ data, meta: { nextCursor: null } }, columns);
        return;
      }

      const page = await api.get<ListEnvelope<SubscriptionDto>>(basePath(newsletterId), {
        ...query,
        limit: flags.limit,
        cursor: flags.cursor,
      });
      c.printer.table(page, columns);
    });

  subs
    .command('add <newsletterId>')
    .description('Subscribe an address')
    .option('--email <email>', 'address to subscribe')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--field <key=value>', 'merge field (repeatable)', collect, [])
    .option('--no-double-opt-in', 'subscribe immediately without a confirmation email')
    .action(async (newsletterId: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          email: emailFlag.optional(),
          tag: z.array(z.string().trim().min(1).max(64)).default([]),
          field: z.array(z.string()).default([]),
          // commander maps `--no-double-opt-in` to `doubleOptIn: false`.
          doubleOptIn: z.boolean().default(true),
        }),
        raw,
      );

      const email = await promptText(flags.email, {
        message: 'Email address',
        flag: '--email',
        validate: (v) => (emailFlag.safeParse(v).success ? undefined : 'Not a valid email address.'),
      });

      const api = await c.api();
      const subscription = await api.post<SubscriptionDto>(basePath(newsletterId), {
        email,
        tags: flags.tag.length > 0 ? flags.tag : undefined,
        mergeFields: parseKeyValue(flags.field),
        doubleOptIn: flags.doubleOptIn,
      });

      c.printer.data(subscription);
      c.printer.success(
        subscription.status === 'pending'
          ? `Added ${subscription.email} — a confirmation email was sent (${subscription.id}).`
          : `Subscribed ${subscription.email} (${subscription.id}).`,
      );
    });

  subs
    .command('confirm <newsletterId> <id>')
    .description('Confirm a pending (double opt-in) subscription')
    .action(async (newsletterId: string, id: string) => {
      const c = ctx();
      const api = await c.api();
      const subscription = await api.post<SubscriptionDto>(
        `${basePath(newsletterId)}/${encodeURIComponent(id)}/confirm`,
      );
      c.printer.data(subscription);
      c.printer.success(`Confirmed ${subscription.email}`);
    });

  subs
    .command('unsubscribe <newsletterId> <id>')
    .description('Unsubscribe a subscription (this newsletter only)')
    .action(async (newsletterId: string, id: string) => {
      const c = ctx();
      await confirmAction(`Unsubscribe ${id} from ${newsletterId}?`, c.assumeYes);
      const api = await c.api();
      const subscription = await api.post<SubscriptionDto>(
        `${basePath(newsletterId)}/${encodeURIComponent(id)}/unsubscribe`,
      );
      c.printer.data(subscription);
      // Worth stating plainly: this is per-newsletter status, not the global
      // suppression list (ADR-015) — they are separate on purpose.
      c.printer.success(`Unsubscribed ${subscription.email} from this newsletter.`);
    });

  subs
    .command('import <newsletterId> <file>')
    .description('Bulk-subscribe from a CSV file (an `email` column, plus optional `tags`)')
    .option('--no-double-opt-in', 'subscribe immediately without confirmation emails')
    .option('--dry-run', 'parse and report without calling the API')
    .option('--continue-on-error', 'keep going past failed rows instead of stopping')
    .action(async (newsletterId: string, file: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          doubleOptIn: z.boolean().default(true),
          dryRun: z.boolean().default(false),
          continueOnError: z.boolean().default(false),
        }),
        raw,
      );

      const rows = parseCsv(await readFile(file, 'utf8'));
      const parsed = rows.map(toSubscribeBody);

      const invalid = parsed.filter((p) => p.error !== undefined);
      if (invalid.length > 0 && !flags.continueOnError) {
        throw new FlagError(
          `${invalid.length} of ${parsed.length} rows are invalid (first: ${invalid[0]?.error}). ` +
            'Fix them, or pass --continue-on-error to import the rest.',
        );
      }

      const valid = parsed.filter((p) => p.error === undefined);
      if (flags.dryRun) {
        c.printer.data({ rows: parsed.length, valid: valid.length, invalid: invalid.length });
        c.printer.success(`Dry run: ${valid.length} of ${parsed.length} rows would be imported.`);
        return;
      }

      await confirmAction(
        `Import ${valid.length} subscriber(s) into ${newsletterId}?`,
        c.assumeYes,
        { destructive: false },
      );

      const api = await c.api();
      const failures: { email: string; reason: string }[] = [];
      let imported = 0;

      // Sequential on purpose: the API has no bulk-subscribe endpoint, and
      // firing hundreds of concurrent writes at a single-node deployment is a
      // good way to get rate-limited or to fall over. Throughput is not the
      // point here; a complete, ordered, resumable report is.
      for (const row of valid) {
        try {
          await api.post(basePath(newsletterId), {
            ...row.body,
            doubleOptIn: flags.doubleOptIn,
          });
          imported += 1;
        } catch (err) {
          const reason = err instanceof ApiError ? err.message : String(err);
          failures.push({ email: row.body.email, reason });
          if (!flags.continueOnError) {
            c.printer.data({ imported, failed: failures.length, failures });
            // A partial import is a real failure, not a usage error — the
            // exit code has to distinguish "you typed it wrong" from "half
            // your list is in and half is not".
            throw new Error(
              `Import stopped at ${row.body.email}: ${reason}. ` +
                `${imported} row(s) were imported. Pass --continue-on-error to skip failures.`,
            );
          }
        }
      }

      c.printer.data({ imported, failed: failures.length + invalid.length, failures });
      c.printer.success(`Imported ${imported} of ${parsed.length} row(s).`);
      if (failures.length > 0 || invalid.length > 0) {
        c.printer.warn(`${failures.length + invalid.length} row(s) failed.`);
        process.exitCode = 1;
      }
    });
}

interface ParsedRow {
  body: { email: string; tags?: string[]; mergeFields?: Record<string, unknown> };
  error?: string;
}

/**
 * Maps a CSV row to a subscribe body. `email` is required; `tags` is a
 * semicolon-separated list (a comma would collide with the CSV delimiter, which
 * is exactly the kind of paper cut that makes an import silently wrong); every
 * remaining column becomes a merge field, so `firstName` in the header lands in
 * `mergeFields.firstName` and is available to templates.
 */
export function toSubscribeBody(row: Record<string, string>): ParsedRow {
  // The two reserved columns are matched case-insensitively (`Email` from a
  // spreadsheet is still the email column); every other header keeps its exact
  // casing, because it becomes a merge field a template refers to by name.
  const emailColumn = column(row, 'email');
  const tagsColumn = column(row, 'tags');

  const email = emailColumn?.value ?? '';
  const parsedEmail = emailFlag.safeParse(email);
  if (!parsedEmail.success) {
    return { body: { email }, error: `"${email}" is not a valid email address` };
  }

  const tags = (tagsColumn?.value ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const reserved = new Set([emailColumn?.key, tagsColumn?.key]);
  const mergeFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (reserved.has(key) || value === '') continue;
    mergeFields[key] = value;
  }

  return {
    body: {
      email: parsedEmail.data,
      tags: tags.length > 0 ? tags : undefined,
      mergeFields: Object.keys(mergeFields).length > 0 ? mergeFields : undefined,
    },
  };
}
