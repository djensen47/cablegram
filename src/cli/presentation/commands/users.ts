import { Command } from 'commander';
import { z } from 'zod';
import type { ListEnvelope, UserDto } from '../../application/dtos.js';
import type { CommandContext } from '../context.js';
import { emailFlag, paginationFlags, parseFlags } from '../flags.js';
import { shortDate, type Column } from '../output.js';
import { promptPassword, promptText } from '../prompts.js';

/**
 * `/v1/users` — admin-only account management (ADR-013).
 *
 * The role check lives entirely server-side (`requireRole('admin')`). The CLI
 * does **not** pre-check the local token's `role` claim and refuse: that claim
 * is unverified (ADR-016 §1), so treating it as authorization would be
 * security theatre. A manager running these gets the server's 403, which is the
 * real answer.
 */

const columns: Column<UserDto>[] = [
  { header: 'id', value: (u) => u.id },
  { header: 'email', value: (u) => u.email },
  { header: 'role', value: (u) => u.role },
  { header: 'created', value: (u) => shortDate(u.createdAt) },
];

export function registerUserCommands(program: Command, ctx: () => CommandContext): void {
  const users = program.command('users').description('Manage user accounts (admin only)');

  users
    .command('list', { isDefault: true })
    .description('List users')
    .option('--limit <n>', 'page size (1-100)', '20')
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(paginationFlags, raw);
      const api = await c.api();

      if (flags.all) {
        const data = await api.listAll<UserDto>('/v1/users');
        c.printer.table({ data, meta: { nextCursor: null } }, columns);
        return;
      }

      const page = await api.get<ListEnvelope<UserDto>>('/v1/users', {
        limit: flags.limit,
        cursor: flags.cursor,
      });
      c.printer.table(page, columns);
    });

  users
    .command('get <id>')
    .description('Show one user')
    .action(async (id: string) => {
      const c = ctx();
      const api = await c.api();
      const user = await api.get<UserDto>(`/v1/users/${encodeURIComponent(id)}`);
      c.printer.detail({ ...user }, user);
    });

  users
    .command('create')
    .description('Create a user')
    .option('--email <email>', 'email address')
    .option('--role <role>', 'admin | manager', 'manager')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(
        z.object({
          email: emailFlag.optional(),
          role: z.enum(['admin', 'manager']).default('manager'),
        }),
        raw,
      );

      const email = await promptText(flags.email, {
        message: 'Email address',
        flag: '--email',
        validate: (v) => (emailFlag.safeParse(v).success ? undefined : 'Not a valid email address.'),
      });
      const password = await promptPassword(`Password for ${email}`, { confirmMatch: true });

      const api = await c.api();
      const user = await api.post<UserDto>('/v1/users', { email, password, role: flags.role });

      c.printer.data(user);
      c.printer.success(`Created ${user.role} ${user.email} (${user.id})`);
    });
}
