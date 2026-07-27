import { cancel, confirm, isCancel, password, text } from '@clack/prompts';

/**
 * The interactive surface (ADR-016 §3) — deliberately small. Commands are
 * one-shot and scriptable; prompting is the fallback for the three cases where
 * a flag is worse than a question.
 *
 * Every prompt here is guarded by {@link isInteractive}. In a pipe, a cron job,
 * or CI there is no one to answer, so a missing input must fail loudly rather
 * than block forever on a read that will never return — a hung scheduled send
 * is far worse than an error.
 */

export class NonInteractiveError extends Error {
  constructor(what: string, flag: string) {
    super(`${what} is required. Pass ${flag} — there is no TTY to prompt on.`);
    this.name = 'NonInteractiveError';
  }
}

/** Raised when the operator aborts a prompt (Ctrl-C / Esc). */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Unwraps a clack result, turning its cancel sentinel into a thrown error. */
function unwrap<T>(result: T | symbol): T {
  if (isCancel(result)) {
    cancel('Cancelled.');
    throw new CancelledError();
  }
  return result as T;
}

export interface PromptTextOptions {
  message: string;
  /** Flag named in the error when there is no TTY, e.g. `--name`. */
  flag: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}

/**
 * Returns `provided` if the operator already passed it; otherwise prompts.
 * This is the shape that keeps every command scriptable: the flag path never
 * touches the terminal.
 */
export async function promptText(
  provided: string | undefined,
  options: PromptTextOptions,
): Promise<string> {
  if (provided !== undefined && provided.length > 0) return provided;
  if (!isInteractive()) throw new NonInteractiveError(options.message, options.flag);

  const value = unwrap(
    await text({
      message: options.message,
      placeholder: options.placeholder,
      initialValue: options.initialValue,
      // clack types the callback's argument as possibly undefined (the prompt
      // can be submitted empty), so normalize before validating.
      validate: (input) => {
        const value = (input ?? '').trim();
        if (value.length === 0) return 'Required.';
        return options.validate?.(value);
      },
    }),
  );
  return value.trim();
}

/**
 * Prompts for a secret with the input masked. There is intentionally no
 * `--password` flag anywhere in this CLI: a password passed as an argument is
 * written to shell history and is visible in `ps` to every user on the box
 * (ADR-016 §3). `CABLEGRAM_PASSWORD` exists for CI, where an env var is the
 * least-bad option.
 */
export async function promptPassword(
  message: string,
  { confirmMatch = false, envVar = 'CABLEGRAM_PASSWORD' } = {},
): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!isInteractive()) {
    throw new NonInteractiveError(message, `${envVar} as an environment variable`);
  }

  const value = unwrap(
    await password({
      message,
      validate: (input) => ((input ?? '').length < 8 ? 'Must be at least 8 characters.' : undefined),
    }),
  );

  if (confirmMatch) {
    const again = unwrap(await password({ message: 'Confirm password' }));
    if (again !== value) throw new Error('Passwords did not match.');
  }
  return value;
}

/**
 * Confirms an irreversible action. `--yes` (passed as `assumeYes`) skips it, so
 * automation is possible but never accidental. Without a TTY and without
 * `--yes` this refuses rather than assuming consent: silently proceeding is how
 * a script mails a draft to the whole list.
 */
export async function confirmAction(
  message: string,
  assumeYes: boolean,
  { destructive = true } = {},
): Promise<void> {
  if (assumeYes) return;
  if (!isInteractive()) {
    throw new NonInteractiveError(`Confirmation for "${message}"`, '--yes');
  }

  const ok = unwrap(await confirm({ message, initialValue: !destructive }));
  if (!ok) throw new CancelledError();
}
