import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../../application/api-error.js';
import {
  SUBSCRIPTION_STATUSES,
  type ImportResultDto,
  type ListEnvelope,
  type SubscriptionDto,
  type SubscriptionStatus,
} from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import {
  collect,
  emailFlag,
  FlagError,
  ipFlag,
  paginationFlags,
  parseFlags,
  parseKeyValue,
  userAgentFlag,
} from '../flags.js';
import { column, parseCsv } from '../csv.js';
import { shortDate, type Column } from '../output.js';
import { confirmAction, promptText } from '../prompts.js';

/**
 * `/v1/newsletters/{newsletterId}/subscriptions` — flat, per-newsletter
 * membership. Every command takes a newsletter id first because there is no
 * cross-newsletter contact identity (ADR-011): the same address in two
 * newsletters is two independent records.
 */

/**
 * The API's per-request row cap, mirrored from the contract rather than
 * imported (ADR-016 — the CLI sees the contract, not the code). Validating it
 * here means an oversized `--batch-size` is caught before the round trip.
 */
const IMPORT_BATCH_LIMIT = 1000;

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
    .option('--status <status>', 'pending | subscribed | unsubscribed | bounced | complained')
    .option('--tag <tag>', 'only subscriptions carrying this tag')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (newsletterId: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        paginationFlags.extend({
          status: z.enum(['pending', 'subscribed', 'unsubscribed', 'bounced', 'complained']).optional(),
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
    .option('--field <key=value>', 'custom field (repeatable)', collect, [])
    .option('--no-double-opt-in', 'subscribe immediately without a confirmation email')
    .option('--signup-ip <ip>', 'the subscriber’s IP, as your signup form observed it')
    .option('--signup-user-agent <ua>', 'the subscriber’s user agent at signup')
    .action(async (newsletterId: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          email: emailFlag.optional(),
          tag: z.array(z.string().trim().min(1).max(64)).default([]),
          field: z.array(z.string()).default([]),
          // commander maps `--no-double-opt-in` to `doubleOptIn: false`.
          doubleOptIn: z.boolean().default(true),
          // Consent evidence (ADR-023). Passed in rather than observed: even
          // here the request reaching the API comes from this machine, not from
          // the subscriber — this is for relaying what a form or forum recorded.
          signupIp: ipFlag.optional(),
          signupUserAgent: z.string().trim().min(1).max(500).optional(),
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
        customFields: parseKeyValue(flags.field),
        doubleOptIn: flags.doubleOptIn,
        signupIp: flags.signupIp,
        signupUserAgent: flags.signupUserAgent,
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
    .option('--ip <ip>', 'the subscriber’s IP at the moment they confirmed')
    .option('--user-agent <ua>', 'the subscriber’s user agent at the moment they confirmed')
    .action(async (newsletterId: string, id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({ ip: ipFlag.optional(), userAgent: userAgentFlag.optional() }),
        raw,
      );
      const api = await c.api();
      const subscription = await api.post<SubscriptionDto>(
        `${basePath(newsletterId)}/${encodeURIComponent(id)}/confirm`,
        { ip: flags.ip, userAgent: flags.userAgent },
      );
      c.printer.data(subscription);
      c.printer.success(`Confirmed ${subscription.email}`);
    });

  subs
    .command('unsubscribe <newsletterId> <id>')
    .description('Unsubscribe a subscription (this newsletter only)')
    .option('--ip <ip>', 'the subscriber’s IP, if they asked through a form you host')
    .option('--user-agent <ua>', 'the subscriber’s user agent, if you observed it')
    .action(async (newsletterId: string, id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({ ip: ipFlag.optional(), userAgent: userAgentFlag.optional() }),
        raw,
      );
      await confirmAction(`Unsubscribe ${id} from ${newsletterId}?`, c.assumeYes);
      const api = await c.api();
      const subscription = await api.post<SubscriptionDto>(
        `${basePath(newsletterId)}/${encodeURIComponent(id)}/unsubscribe`,
        { ip: flags.ip, userAgent: flags.userAgent },
      );
      c.printer.data(subscription);
      // Worth stating plainly: this is per-newsletter status, not the global
      // suppression list (ADR-015) — they are separate on purpose.
      c.printer.success(`Unsubscribed ${subscription.email} from this newsletter.`);
    });

  subs
    .command('import <newsletterId> <file>')
    .description(
      'Import memberships from a CSV file, preserving each row’s status — a migration, not a ' +
        'bulk subscribe. Sends no email.',
    )
    .option(
      '--on-conflict <mode>',
      'skip (default) leaves an existing membership untouched; overwrite makes the file the ' +
        'source of truth for it',
      'skip',
    )
    .option('--default-status <status>', 'status for rows with no `status` column', 'subscribed')
    .option(
      '--source <note>',
      'where this list came from, recorded on every imported row (e.g. mailchimp-export-2026-07); ' +
        'defaults to `import`',
    )
    .option('--batch-size <n>', `rows per request (1-${IMPORT_BATCH_LIMIT})`, '500')
    .option('--dry-run', 'parse and report the status breakdown without calling the API')
    .option('--continue-on-error', 'keep going past failed rows and batches instead of stopping')
    .action(async (newsletterId: string, file: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          onConflict: z.enum(['skip', 'overwrite']),
          defaultStatus: z.enum(SUBSCRIPTION_STATUSES),
          source: z.string().trim().min(1).max(200).optional(),
          batchSize: z.coerce.number().int().min(1).max(IMPORT_BATCH_LIMIT),
          dryRun: z.boolean().default(false),
          continueOnError: z.boolean().default(false),
        }),
        raw,
      );

      const parsed = parseCsv(await readFile(file, 'utf8')).map(toImportRow);
      const invalid = parsed.filter((p) => p.error !== undefined);
      const valid = parsed.filter((p) => p.error === undefined).map((p) => p.row);

      if (invalid.length > 0 && !flags.continueOnError) {
        throw new FlagError(
          `${invalid.length} of ${parsed.length} rows are invalid (first: ${invalid[0]?.error}). ` +
            'Fix them, or pass --continue-on-error to import the rest.',
        );
      }

      // The breakdown is the point of the dry run: seeing "1,204 unsubscribed"
      // before the fact is what tells an operator the export was exported
      // correctly, and it is the last chance to catch a file that would have
      // silently re-subscribed everyone.
      const breakdown = countByStatus(valid, flags.defaultStatus);
      if (flags.dryRun) {
        c.printer.data({
          rows: parsed.length,
          valid: valid.length,
          invalid: invalid.length,
          byStatus: breakdown,
          wouldSuppress: breakdown.bounced ?? 0,
          source: flags.source ?? 'import',
        });
        c.printer.line(formatBreakdown(breakdown));
        c.printer.success(
          `Dry run: ${valid.length} of ${parsed.length} row(s) would be imported ` +
            `(--on-conflict ${flags.onConflict}). Nothing was written.`,
        );
        return;
      }

      c.printer.line(formatBreakdown(breakdown));
      await confirmAction(
        `Import ${valid.length} row(s) into ${newsletterId} with --on-conflict ${flags.onConflict}?`,
        c.assumeYes,
        { destructive: flags.onConflict === 'overwrite' },
      );

      const api = await c.api();
      const batches = chunk(valid, flags.batchSize);
      const totals: ImportResultDto = {
        received: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        suppressed: 0,
        byStatus: {},
      };
      const failures: { batch: number; rows: number; reason: string }[] = [];

      for (const [index, batch] of batches.entries()) {
        try {
          const result = await api.post<ImportResultDto>(
            `${basePath(newsletterId)}/import`,
            {
              rows: batch,
              onConflict: flags.onConflict,
              defaultStatus: flags.defaultStatus,
              source: flags.source,
            },
            {
              // A batch is the unit of retry: if the response is lost, the same
              // key replays the stored result instead of re-running the write.
              // Derived from the file and the batch index so a resumed run
              // reuses the same keys — which is what makes a re-run cheap.
              idempotencyKey: `import:${newsletterId}:${basename(file)}:${index}`,
            },
          );
          accumulate(totals, result);
        } catch (err) {
          const reason = err instanceof ApiError ? err.message : String(err);
          failures.push({ batch: index + 1, rows: batch.length, reason });
          if (!flags.continueOnError) {
            c.printer.data({ ...totals, failed: failures.length, failures });
            // A partial import is a real failure, not a usage error — the exit
            // code has to distinguish "you typed it wrong" from "half your list
            // is in and half is not". Re-running is safe: `skip` no-ops what
            // already landed, and the idempotency keys replay whole batches.
            throw new Error(
              `Import stopped in batch ${index + 1} of ${batches.length}: ${reason}. ` +
                `${totals.created + totals.updated} row(s) were written. Re-running is safe; ` +
                'pass --continue-on-error to skip failing batches.',
            );
          }
        }

        // Progress goes to stderr, so `--json` stays a clean document. An 18k
        // import is minutes long; a silent terminal for that long is
        // indistinguishable from a hang.
        c.printer.dim(
          `batch ${index + 1}/${batches.length} — ` +
            `${totals.created} created, ${totals.updated} updated, ${totals.skipped} skipped`,
        );
      }

      c.printer.data({ ...totals, failed: failures.length, failures });
      c.printer.success(
        `Imported ${valid.length} row(s): ${totals.created} created, ${totals.updated} updated, ` +
          `${totals.skipped} skipped.`,
      );
      if (totals.suppressed > 0) {
        // Worth stating out loud: this is the one part of an import that
        // reaches beyond this newsletter (ADR-018).
        c.printer.warn(
          `${totals.suppressed} imported hard bounce(s) were added to the GLOBAL suppression ` +
            'list — they will not receive mail from any newsletter.',
        );
      }
      if (failures.length > 0 || invalid.length > 0) {
        c.printer.warn(
          `${invalid.length} row(s) were invalid and ${failures.length} batch(es) failed.`,
        );
        process.exitCode = 1;
      }
    });
}

interface ParsedRow {
  row: ImportRowBody;
  error?: string;
}

interface ImportRowBody {
  email: string;
  status?: SubscriptionStatus;
  tags?: string[];
  customFields?: Record<string, unknown>;
  subscribedAt?: string;
  source?: string;
  signupIp?: string;
  signupUserAgent?: string;
  confirmedAt?: string;
  confirmedIp?: string;
  confirmedUserAgent?: string;
  unsubscribedAt?: string;
  unsubscribedIp?: string;
  unsubscribedUserAgent?: string;
}

/**
 * The consent-trail columns an export may carry (ADR-023). Reserved for the
 * same reason as `source`: silently turning an opt-in IP into a renderable
 * custom field would be both a lost record and a leak waiting to happen.
 */
const CONSENT_DATE_COLUMNS = ['confirmedAt', 'unsubscribedAt'] as const;
const CONSENT_TEXT_COLUMNS = [
  'signupIp',
  'signupUserAgent',
  'confirmedIp',
  'confirmedUserAgent',
  'unsubscribedIp',
  'unsubscribedUserAgent',
] as const;

/**
 * Maps a CSV row to an import row. `email` is required; `status` restores the
 * membership's lifecycle state and `subscribedAt` its original opt-in date;
 * `tags` is a semicolon-separated list (a comma would collide with the CSV
 * delimiter, which is exactly the kind of paper cut that makes an import
 * silently wrong); every remaining column becomes a custom field, so `firstName`
 * in the header lands in `customFields.firstName` and is available to templates.
 *
 * An unknown `status` fails the row rather than defaulting. Guessing here would
 * mean quietly turning someone's `unsubscribed` into a `subscribed`, which is
 * the single worst thing this command could do.
 */
export function toImportRow(row: Record<string, string>): ParsedRow {
  // The reserved columns are matched case-insensitively (`Email` from a
  // spreadsheet is still the email column); every other header keeps its exact
  // casing, because it becomes a custom field a template refers to by name.
  const emailColumn = column(row, 'email');
  const tagsColumn = column(row, 'tags');
  const statusColumn = column(row, 'status');
  const subscribedAtColumn = column(row, 'subscribedAt');
  // Reserved rather than left to fall through to custom fields: provenance is
  // metadata about the record, and a `{{source}}` placeholder that renders into
  // a campaign is not what an operator means by a `source` column.
  const sourceColumn = column(row, 'source');

  const email = emailColumn?.value ?? '';
  const parsedEmail = emailFlag.safeParse(email);
  if (!parsedEmail.success) {
    return { row: { email }, error: `"${email}" is not a valid email address` };
  }

  let status: SubscriptionStatus | undefined;
  const rawStatus = statusColumn?.value.trim() ?? '';
  if (rawStatus.length > 0) {
    const parsedStatus = z.enum(SUBSCRIPTION_STATUSES).safeParse(rawStatus.toLowerCase());
    if (!parsedStatus.success) {
      return {
        row: { email: parsedEmail.data },
        error: `"${rawStatus}" is not a valid status (${SUBSCRIPTION_STATUSES.join(' | ')})`,
      };
    }
    status = parsedStatus.data;
  }

  const dateColumns = ['subscribedAt', ...CONSENT_DATE_COLUMNS] as const;
  const dates: Partial<Record<(typeof dateColumns)[number], string>> = {};
  for (const name of dateColumns) {
    const raw = column(row, name)?.value.trim() ?? '';
    if (raw.length === 0) continue;
    const parsedDate = Date.parse(raw);
    if (Number.isNaN(parsedDate)) {
      return { row: { email: parsedEmail.data }, error: `"${raw}" is not a valid date (${name})` };
    }
    dates[name] = new Date(parsedDate).toISOString();
  }

  const consent: Partial<Record<(typeof CONSENT_TEXT_COLUMNS)[number], string>> = {};
  for (const name of CONSENT_TEXT_COLUMNS) {
    const raw = column(row, name)?.value.trim() ?? '';
    if (raw.length > 0) consent[name] = raw;
  }

  const tags = (tagsColumn?.value ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const reserved = new Set([
    emailColumn?.key,
    tagsColumn?.key,
    statusColumn?.key,
    subscribedAtColumn?.key,
    sourceColumn?.key,
    ...CONSENT_DATE_COLUMNS.map((name) => column(row, name)?.key),
    ...CONSENT_TEXT_COLUMNS.map((name) => column(row, name)?.key),
  ]);
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (reserved.has(key) || value === '') continue;
    customFields[key] = value;
  }

  return {
    row: {
      email: parsedEmail.data,
      status,
      tags: tags.length > 0 ? tags : undefined,
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      ...dates,
      ...consent,
      source: sourceColumn?.value.trim() || undefined,
    },
  };
}

function countByStatus(
  rows: readonly ImportRowBody[],
  defaultStatus: SubscriptionStatus,
): Partial<Record<SubscriptionStatus, number>> {
  const counts: Partial<Record<SubscriptionStatus, number>> = {};
  for (const row of rows) {
    const status = row.status ?? defaultStatus;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function formatBreakdown(counts: Partial<Record<SubscriptionStatus, number>>): string {
  const parts = SUBSCRIPTION_STATUSES.filter((s) => (counts[s] ?? 0) > 0).map(
    (s) => `${counts[s]} ${s}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'no rows';
}

function accumulate(totals: ImportResultDto, batch: ImportResultDto): void {
  totals.received += batch.received;
  totals.created += batch.created;
  totals.updated += batch.updated;
  totals.skipped += batch.skipped;
  totals.suppressed += batch.suppressed;
  for (const [status, count] of Object.entries(batch.byStatus)) {
    const key = status as SubscriptionStatus;
    totals.byStatus[key] = (totals.byStatus[key] ?? 0) + count;
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
