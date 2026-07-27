import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { z } from 'zod';
import type { ListEnvelope, TemplateDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { paginationFlags, parseFlags } from '../flags.js';
import { pruneUndefined } from './newsletters.js';
import { shortDate, truncate, type Column } from '../output.js';
import { confirmAction, promptText } from '../prompts.js';

/**
 * `/v1/templates` — reusable, renderable message shapes.
 *
 * Bodies come from **files**, never from a flag: a template body is HTML with
 * Handlebars placeholders, routinely thousands of characters, and shells mangle
 * quotes and expand `{{...}}` unpredictably. `--html <file>` sidesteps all of
 * it and keeps the template under version control where it belongs.
 */

const columns: Column<TemplateDto>[] = [
  { header: 'id', value: (t) => t.id },
  { header: 'name', value: (t) => truncate(t.name, 28) },
  { header: 'subject', value: (t) => truncate(t.subject, 40) },
  { header: 'updated', value: (t) => shortDate(t.updatedAt) },
];

export function registerTemplateCommands(program: Command, ctx: () => CommandContext): void {
  const templates = program.command('templates').description('Manage templates');

  templates
    .command('list', { isDefault: true })
    .description('List templates')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(paginationFlags, raw);
      const api = await c.api();

      if (flags.all) {
        const data = await api.listAll<TemplateDto>('/v1/templates');
        c.printer.table({ data, meta: { nextCursor: null } }, columns);
        return;
      }

      const page = await api.get<ListEnvelope<TemplateDto>>('/v1/templates', {
        limit: flags.limit,
        cursor: flags.cursor,
      });
      c.printer.table(page, columns);
    });

  templates
    .command('get <id>')
    .description('Show one template')
    .option('--body', 'print only the HTML body (for piping to a file or a browser)')
    .action(async (id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(z.object({ body: z.boolean().default(false) }), raw);
      const api = await c.api();
      const template = await api.get<TemplateDto>(`/v1/templates/${encodeURIComponent(id)}`);

      if (flags.body && !c.printer.isJson) {
        c.printer.line(template.bodyHtml);
        return;
      }

      c.printer.detail(
        {
          id: template.id,
          name: template.name,
          subject: template.subject,
          bodyHtml: truncate(template.bodyHtml, 120),
          bodyText: template.bodyText === null ? null : truncate(template.bodyText, 120),
          updatedAt: template.updatedAt,
        },
        template,
      );
    });

  templates
    .command('create')
    .description('Create a template')
    .option('--name <name>', 'template name')
    .option('--subject <subject>', 'subject line (Handlebars placeholders allowed)')
    .option('--html <file>', 'file containing the HTML body')
    .option('--text <file>', 'file containing the plain-text body')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          name: z.string().trim().min(1).max(200).optional(),
          subject: z.string().trim().min(1).max(500).optional(),
          html: z.string().optional(),
          text: z.string().optional(),
        }),
        raw,
      );

      const name = await promptText(flags.name, { message: 'Template name', flag: '--name' });
      const subject = await promptText(flags.subject, {
        message: 'Subject line',
        flag: '--subject',
      });
      const htmlPath = await promptText(flags.html, {
        message: 'Path to the HTML body file',
        flag: '--html',
      });

      const api = await c.api();
      const template = await api.post<TemplateDto>('/v1/templates', {
        name,
        subject,
        bodyHtml: await readFile(htmlPath, 'utf8'),
        bodyText: flags.text === undefined ? undefined : await readFile(flags.text, 'utf8'),
      });

      c.printer.data(template);
      c.printer.success(`Created template ${template.id}`);
    });

  templates
    .command('update <id>')
    .description('Update a template')
    .option('--name <name>', 'template name')
    .option('--subject <subject>', 'subject line')
    .option('--html <file>', 'file containing the HTML body')
    .option('--text <file>', 'file containing the plain-text body')
    .action(async (id: string, raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          name: z.string().trim().min(1).max(200).optional(),
          subject: z.string().trim().min(1).max(500).optional(),
          html: z.string().optional(),
          text: z.string().optional(),
        }),
        raw,
      );

      const body = pruneUndefined({
        name: flags.name,
        subject: flags.subject,
        bodyHtml: flags.html === undefined ? undefined : await readFile(flags.html, 'utf8'),
        bodyText: flags.text === undefined ? undefined : await readFile(flags.text, 'utf8'),
      });

      if (Object.keys(body).length === 0) {
        c.printer.warn('Nothing to update — pass at least one field.');
        process.exitCode = 2;
        return;
      }

      const api = await c.api();
      const template = await api.patch<TemplateDto>(
        `/v1/templates/${encodeURIComponent(id)}`,
        body,
      );
      c.printer.data(template);
      c.printer.success(`Updated template ${template.id}`);
    });

  templates
    .command('delete <id>')
    .description('Delete a template')
    .action(async (id: string) => {
      const c = ctx();
      await confirmAction(`Delete template ${id}?`, c.assumeYes);
      const api = await c.api();
      await api.delete(`/v1/templates/${encodeURIComponent(id)}`);
      c.printer.success(`Deleted template ${id}`);
    });
}
