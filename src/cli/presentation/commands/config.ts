import { Command } from 'commander';
import type { CommandContext } from '../context.js';
import { decodeClaims } from '../../application/session.js';
import { shortDate } from '../output.js';
import { normalizeUrl } from './auth.js';

/**
 * `cablegram config` — inspect and point the CLI at a deployment.
 *
 * Kept small on purpose. This is a session file, not a settings system: the
 * only thing worth configuring is which deployment to talk to, and everything
 * else in it is a credential the operator should not be hand-editing.
 */
export function registerConfigCommands(program: Command, ctx: () => CommandContext): void {
  const config = program.command('config').description('Inspect the CLI configuration');

  config
    .command('show', { isDefault: true })
    .description('Show the stored configuration (tokens are never printed)')
    .action(async () => {
      const c = ctx();
      const stored = await c.deps.store.load();
      const claims =
        stored?.accessToken === undefined ? null : decodeClaims(stored.accessToken);

      // Deliberately reports token *presence* and expiry, never the values. A
      // config dump is the kind of thing that ends up pasted into an issue.
      const view = {
        configFile: c.deps.store.location(),
        url: stored?.baseUrl ?? '(not set)',
        loggedInAs: claims === null ? '(not logged in)' : `${claims.userId} (${claims.role})`,
        accessTokenExpires: shortDate(stored?.accessTokenExpiresAt),
        refreshToken: stored?.refreshToken === undefined ? '(none)' : '(stored)',
      };

      c.printer.detail(view);
    });

  config
    .command('set-url <url>')
    .description('Point the CLI at a different deployment')
    .action(async (url: string) => {
      const c = ctx();
      const normalized = normalizeUrl(url);
      const stored = await c.deps.store.load();

      // Switching deployments invalidates the session: tokens are signed by the
      // old server and mean nothing to the new one. Drop them rather than leave
      // credentials that will only produce a confusing 401.
      const switching = stored !== null && stored.baseUrl !== normalized;
      await c.deps.store.save({ baseUrl: normalized });

      c.printer.success(`URL set to ${normalized}`);
      if (switching || stored?.refreshToken !== undefined) {
        c.printer.dim('The previous session was cleared — run `cablegram login`.');
      }
    });

  config
    .command('path')
    .description('Print the path to the config file')
    .action(() => {
      const c = ctx();
      c.printer.line(c.deps.store.location());
    });
}
