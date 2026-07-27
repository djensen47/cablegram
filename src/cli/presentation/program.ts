import { Command, CommanderError } from 'commander';
import { ApiError } from '../application/api-error.js';
import type { CliDeps } from '../application/deps.js';
import { createContext, type GlobalOptions } from './context.js';
import { FlagError } from './flags.js';
import { CsvError } from './csv.js';
import { Printer, resolveOutputOptions } from './output.js';
import { CancelledError, NonInteractiveError } from './prompts.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerCampaignCommands } from './commands/campaigns.js';
import { registerConfigCommands } from './commands/config.js';
import { registerNewsletterCommands } from './commands/newsletters.js';
import { registerSubscriptionCommands } from './commands/subscriptions.js';
import { registerSuppressionCommands } from './commands/suppressions.js';
import { registerTemplateCommands } from './commands/templates.js';
import { registerUserCommands } from './commands/users.js';

/**
 * Exit codes, so scripts can branch on the *kind* of failure rather than
 * scraping stderr:
 *
 *   0  success
 *   1  the request was understood and refused (404, 409, 403, or a partial import)
 *   2  the invocation was wrong (bad flag, missing argument, no TTY to prompt on)
 *   3  not authenticated / session expired
 *   4  the deployment could not be reached
 *   130 cancelled at a prompt (the shell convention for SIGINT)
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  auth: 3,
  unreachable: 4,
  cancelled: 130,
} as const;

/** The CLI version, surfaced by `--version`. Kept in step with package.json. */
export const CLI_VERSION = '0.1.0';

/**
 * Builds the commander program (ADR-016 §2). Takes its dependencies rather than
 * constructing them, so tests drive the real program with a stub API client and
 * an in-memory credential store — the CLI equivalent of the server's route tests
 * rebinding repositories (ADR-003).
 *
 * Command groups register themselves through `register*Commands`, which is what
 * keeps a future `cablegram shell` cheap: a REPL would dispatch into this same
 * registry rather than reimplementing it.
 */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command();

  program
    .name('cablegram')
    .description(
      'CLI for a cablegram deployment. An HTTP client for the /v1 API (ADR-016) — it talks to a ' +
        'running server and never to the database.',
    )
    .version(CLI_VERSION, '-v, --version')
    .option('--json', 'emit the raw API response as JSON (machine-readable)')
    .option('--url <url>', 'override the configured base URL for this command')
    .option('-y, --yes', 'skip confirmation prompts (for scripts and CI)')
    // Errors are rendered by `run`, uniformly; commander must not print its own
    // or call process.exit() out from under us.
    .exitOverride()
    .configureOutput({ writeErr: (str) => process.stderr.write(str) })
    .showHelpAfterError('(run with --help for usage)');

  // Global flags live on the root, but actions hang off subcommands, so each
  // action re-reads them from `program.opts()` at call time.
  const ctx = () => createContext(deps, program.opts<GlobalOptions>());

  registerAuthCommands(program, ctx);
  registerConfigCommands(program, ctx);
  registerNewsletterCommands(program, ctx);
  registerSubscriptionCommands(program, ctx);
  registerCampaignCommands(program, ctx);
  registerTemplateCommands(program, ctx);
  registerSuppressionCommands(program, ctx);
  registerUserCommands(program, ctx);

  program.addHelpText(
    'after',
    `
Examples:
  $ cablegram login --url https://api.example.com
  $ cablegram newsletters create --name "Weekly" --from-name Editors --from-email hi@example.com
  $ cablegram subscriptions import <newsletter-id> subscribers.csv --no-double-opt-in
  $ cablegram campaigns send <campaign-id> --dry-run
  $ cablegram campaigns list --json | jq '.data[] | select(.status == "sent")'

Environment:
  CABLEGRAM_URL       base URL, overriding the stored config
  CABLEGRAM_TOKEN     access token to use directly (CI; never refreshed or stored)
  CABLEGRAM_PASSWORD  password for non-interactive login
  CABLEGRAM_CONFIG    path to the config file (default ~/.config/cablegram/config.json)
`,
  );

  return program;
}

/**
 * Parses and runs, mapping every failure onto a message and an exit code. This
 * is the CLI's `onError` (`shared/http`): one place that knows how each error
 * type should read, so no command has to.
 */
export async function run(deps: CliDeps, argv: string[]): Promise<number> {
  const program = buildProgram(deps);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return process.exitCode === undefined ? EXIT.ok : Number(process.exitCode);
  } catch (err) {
    return handleError(err, program.opts<GlobalOptions>().json === true);
  }
}

function handleError(err: unknown, json: boolean): number {
  const printer = new Printer(resolveOutputOptions(false));

  // `--help` and `--version` reach here as thrown CommanderErrors because of
  // `exitOverride`; they are successful outcomes, not failures.
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return EXIT.ok;
    }
    printer.error(err.message);
    return EXIT.usage;
  }

  if (err instanceof CancelledError) return EXIT.cancelled;

  if (err instanceof FlagError || err instanceof NonInteractiveError || err instanceof CsvError) {
    printer.error(err.message);
    return EXIT.usage;
  }

  if (err instanceof ApiError) {
    printer.error(err.message);
    if (json) process.stdout.write(`${JSON.stringify(errorPayload(err), null, 2)}\n`);

    // `details` is where zod's per-field issues land when the server rejects a
    // body; showing them turns "Invalid request" into something actionable.
    if (err.details !== undefined && !json) {
      printer.dim(JSON.stringify(err.details, null, 2));
    }
    if (err.requestId !== undefined) printer.dim(`request id: ${err.requestId}`);

    if (err.isTransport) return EXIT.unreachable;
    if (err.status === 401 || err.status === 403) return EXIT.auth;
    return EXIT.failed;
  }

  // Node's fs errors are the common remaining case (`--html missing.html`).
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    printer.error(`File not found: ${(err as NodeJS.ErrnoException).path ?? 'unknown'}`);
    return EXIT.usage;
  }

  printer.error(err instanceof Error ? err.message : String(err));
  return EXIT.failed;
}

function errorPayload(err: ApiError): unknown {
  return {
    error: {
      code: err.code,
      message: err.message,
      details: err.details,
      requestId: err.requestId,
    },
  };
}
