import { Command } from 'commander';
import { z } from 'zod';
import type { UserDto } from '../../application/dtos.js';
import {
  credentialsFromSession,
  decodeClaims,
  type SessionResponse,
} from '../../application/session.js';
import type { CommandContext } from '../context.js';
import { emailFlag, parseFlags } from '../flags.js';
import { shortDate } from '../output.js';
import { promptPassword, promptText } from '../prompts.js';

/**
 * The session commands (ADR-013/016): first-run setup, the login/logout
 * exchange, `whoami`, and the two email one-time-token flows.
 *
 * Every one of these hits an **open** `/v1` endpoint, so they use
 * `anonymousApi()` — they are the commands you run *before* you have a token.
 */

const urlFlags = z.object({ url: z.string().url().optional() });

/** Normalizes `api.example.com` → `https://api.example.com`, and drops a trailing slash. */
export function normalizeUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return withScheme.replace(/\/+$/, '');
}

export function registerAuthCommands(program: Command, ctx: () => CommandContext): void {
  program
    .command('setup')
    .description('First-run bootstrap: create the initial admin account')
    .option('--email <email>', 'admin email address')
    .option('--url <url>', 'cablegram base URL')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(urlFlags.extend({ email: emailFlag.optional() }), raw);

      const email = await promptText(flags.email, {
        message: 'Admin email address',
        flag: '--email',
      });
      const password = await promptPassword('Choose a password', { confirmMatch: true });

      const api = await c.anonymousApi();
      const user = await api.post<UserDto>('/v1/setup', { email, password }, { anonymous: true });

      c.printer.data(user);
      c.printer.success(`Created admin ${user.email}. Run \`cablegram login\` to start a session.`);
    });

  program
    .command('login')
    .description('Log in and store a session')
    .option('--email <email>', 'email address')
    .option('--url <url>', 'cablegram base URL (remembered for later commands)')
    .option('--magic-link', 'email a one-time login link instead of using a password')
    .option('--token <token>', 'consume a magic-link token received by email')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(
        urlFlags.extend({
          email: emailFlag.optional(),
          magicLink: z.boolean().default(false),
          token: z.string().min(1).optional(),
        }),
        raw,
      );

      const baseUrl = normalizeUrl(await c.baseUrl());
      const api = await c.anonymousApi();

      // Step 2 of the magic-link flow: exchange the emailed token for a session.
      if (flags.token !== undefined) {
        const session = await api.post<SessionResponse>(
          '/v1/auth/magic-link/consume',
          { token: flags.token },
          { anonymous: true },
        );
        await persistSession(c, baseUrl, session);
        return;
      }

      // Step 1 of the magic-link flow. Non-enumerating by design (ADR-014):
      // the response is identical whether or not the address has an account, so
      // the CLI must not imply that an email was actually sent.
      if (flags.magicLink) {
        const email = await promptText(flags.email, {
          message: 'Email address',
          flag: '--email',
        });
        await api.post('/v1/auth/magic-link', { email }, { anonymous: true });
        c.printer.success('If that address has an account, a login link is on its way.');
        c.printer.dim('Then run: cablegram login --token <token-from-email>');
        return;
      }

      const email = await promptText(flags.email, { message: 'Email address', flag: '--email' });
      const password = await promptPassword('Password');
      const session = await api.post<SessionResponse>(
        '/v1/auth/login',
        { email, password },
        { anonymous: true },
      );
      await persistSession(c, baseUrl, session);
    });

  program
    .command('logout')
    .description('Revoke the stored session')
    .action(async () => {
      const c = ctx();
      const stored = await c.deps.store.load();

      if (stored?.refreshToken !== undefined) {
        try {
          const api = await c.anonymousApi();
          await api.post(
            '/v1/auth/logout',
            { refreshToken: stored.refreshToken },
            { anonymous: true },
          );
        } catch {
          // Server-side revocation is best-effort: an unreachable or already-
          // revoked session must not stop us clearing the local copy, which is
          // the part the operator actually asked for.
          c.printer.warn('Could not reach the server to revoke the session; clearing it locally.');
        }
      }

      await c.deps.store.clear();
      c.printer.success('Logged out.');
    });

  program
    .command('whoami')
    .description('Show the current session')
    .action(async () => {
      const c = ctx();
      const stored = await c.deps.store.load();

      if (stored?.accessToken === undefined) {
        c.printer.error('Not logged in.');
        process.exitCode = 1;
        return;
      }

      // Read locally: there is no `/v1/auth/me` endpoint, and the CLI cannot
      // verify the signature anyway (ADR-016 §1) — these claims are for display.
      const claims = decodeClaims(stored.accessToken);
      const info = {
        url: stored.baseUrl,
        userId: claims?.userId ?? 'unknown',
        role: claims?.role ?? 'unknown',
        accessTokenExpires: shortDate(stored.accessTokenExpiresAt),
        config: c.deps.store.location(),
      };
      c.printer.detail(info);
    });

  const reset = program
    .command('password-reset')
    .description('Request a password-reset email, or complete a reset');

  reset
    .command('request', { isDefault: true })
    .description('Email a password-reset token')
    .option('--email <email>', 'email address')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(z.object({ email: emailFlag.optional() }), raw);
      const email = await promptText(flags.email, { message: 'Email address', flag: '--email' });

      const api = await c.anonymousApi();
      await api.post('/v1/auth/password-reset', { email }, { anonymous: true });
      // Non-enumerating (ADR-013) — same wording discipline as magic-link.
      c.printer.success('If that address has an account, a reset link is on its way.');
    });

  reset
    .command('confirm')
    .description('Complete a password reset with the emailed token')
    .requiredOption('--token <token>', 'the token from the reset email')
    .action(async (raw) => {
      const c = ctx();
      const flags = parseFlags(z.object({ token: z.string().min(1) }), raw);
      const password = await promptPassword('New password', { confirmMatch: true });

      const api = await c.anonymousApi();
      await api.post(
        '/v1/auth/password-reset/confirm',
        { token: flags.token, password },
        { anonymous: true },
      );

      // The server revokes every session on reset, so the stored one is dead.
      await c.deps.store.clear();
      c.printer.success('Password reset. All sessions were revoked — log in again.');
    });
}

/** Stores a fresh session and reports who it belongs to. */
async function persistSession(
  c: CommandContext,
  baseUrl: string,
  session: SessionResponse,
): Promise<void> {
  const credentials = credentialsFromSession(baseUrl, session, c.deps.now());
  await c.deps.store.save(credentials);

  const claims = decodeClaims(session.accessToken);
  c.printer.data({ url: baseUrl, userId: claims?.userId, role: claims?.role });
  c.printer.success(
    claims === null
      ? `Logged in to ${baseUrl}.`
      : `Logged in to ${baseUrl} as ${claims.userId} (${claims.role}).`,
  );
}
