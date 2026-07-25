import type { ApiClient } from '../application/api-client.js';
import { ApiError } from '../application/api-error.js';
import type { StoredCredentials } from '../application/credential-store.js';
import type { CliDeps } from '../application/deps.js';
import { FlagError } from './flags.js';
import { Printer, resolveOutputOptions } from './output.js';

/** The global flags every command inherits from the root program. */
export interface GlobalOptions {
  json?: boolean;
  url?: string;
  yes?: boolean;
}

/**
 * What a command action receives: a printer honoring `--json`, a lazily-built
 * API client, and the shared deps. The client is lazy because commands that
 * need no session at all (`config show`, `logout` when already logged out)
 * should not fail on a missing config.
 */
export class CommandContext {
  private client: ApiClient | null = null;

  constructor(
    readonly deps: CliDeps,
    readonly printer: Printer,
    readonly globals: GlobalOptions,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get assumeYes(): boolean {
    return this.globals.yes === true;
  }

  /**
   * Resolves the credentials to use, in precedence order:
   *
   *   1. `--url` / `CABLEGRAM_URL` + `CABLEGRAM_TOKEN` — the CI path. An
   *      explicitly supplied token is used as-is and never refreshed or
   *      persisted; CI gets a token from its own secret store, and writing to
   *      the runner's home directory would be pointless and surprising.
   *   2. the stored config file.
   *
   * `requireAuth: false` allows the open endpoints (setup, login) to run with
   * only a base URL and no session.
   */
  private async resolveCredentials(requireAuth: boolean): Promise<StoredCredentials> {
    const stored = await this.deps.store.load();
    const envUrl = this.globals.url ?? this.env.CABLEGRAM_URL;
    const envToken = this.env.CABLEGRAM_TOKEN;

    const baseUrl = envUrl ?? stored?.baseUrl;
    if (baseUrl === undefined) {
      // A usage problem, not a network one: nothing was ever configured to
      // reach, so reporting it as "unreachable" would misdirect the fix.
      throw new FlagError(
        'No cablegram URL configured. Run `cablegram login --url <url>`, or set CABLEGRAM_URL.',
      );
    }

    if (envToken !== undefined && envToken.length > 0) {
      return { baseUrl, accessToken: envToken };
    }

    // A `--url` that differs from the stored one points at a different
    // deployment, where the stored token is not valid. Better to say so than to
    // send a foreign token and render its 401.
    const sameDeployment = stored !== null && (envUrl === undefined || envUrl === stored.baseUrl);
    if (requireAuth && (!sameDeployment || stored.refreshToken === undefined)) {
      throw new ApiError(
        `Not logged in to ${baseUrl}. Run \`cablegram login --url ${baseUrl}\`.`,
        401,
        'not_logged_in',
      );
    }

    return sameDeployment && stored !== null ? { ...stored, baseUrl } : { baseUrl };
  }

  /** An authenticated client; fails fast when there is no session. */
  async api(): Promise<ApiClient> {
    this.client ??= this.deps.createClient(await this.resolveCredentials(true));
    return this.client;
  }

  /** A client for the open endpoints (setup, login, password-reset, magic-link). */
  async anonymousApi(): Promise<ApiClient> {
    return this.deps.createClient(await this.resolveCredentials(false));
  }

  /** The base URL a session-less command should act against. */
  async baseUrl(): Promise<string> {
    return (await this.resolveCredentials(false)).baseUrl;
  }
}

/** Builds the context for one command invocation from the merged global flags. */
export function createContext(deps: CliDeps, globals: GlobalOptions): CommandContext {
  const printer = new Printer(resolveOutputOptions(globals.json === true));
  return new CommandContext(deps, printer, globals);
}
