import { z } from 'zod';

/**
 * Flag validation at the CLI edge (ADR-016 §4).
 *
 * This is the deliberate mirror of `shared/http`'s `throwOnInvalid`: commander
 * hands back a loosely-typed bag of strings, and a zod schema turns it into a
 * typed, validated object before the command body runs — exactly the pipeline
 * the HTTP edge uses (ADR-006). Picking commander + zod over a type-inferring
 * parser is what buys this: **one validation idiom, two edges**, rather than
 * two mechanisms doing the same job differently.
 *
 * The payoff is also user-facing. A bad `--limit` is caught here, with a
 * readable message naming the flag, instead of costing a round trip to be
 * rejected by the server's identical rule.
 */

/** Thrown for invalid flags; the top-level handler renders it and exits 2. */
export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagError';
  }
}

/**
 * Validates commander's parsed options, rendering zod issues as flag-shaped
 * messages (`--limit: expected number, received string`).
 */
export function parseFlags<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `--${kebab(path)}: ${issue.message}` : issue.message;
  });
  throw new FlagError(issues.join('\n'));
}

/** commander exposes `--dry-run` as `dryRun`; error messages should say the former. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** `--limit` / `--cursor` / `--all`, matching the API's pagination contract. */
export const paginationFlags = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  all: z.boolean().default(false),
});

/** Repeatable `--tag` values; commander collects these into an array. */
export const tagsFlag = z.array(z.string().trim().min(1).max(64)).optional();

export const emailFlag = z.string().trim().email().max(320);

/**
 * Consent evidence flags (ADR-023). The IP is validated as a real address here,
 * at the CLI edge, for the same reason the API validates it: it is evidence, and
 * a field that sometimes holds an address and sometimes holds a typo proves
 * nothing. Catching it here also saves a round trip.
 */
export const ipFlag = z.string().trim().ip();
export const userAgentFlag = z.string().trim().min(1).max(500);

/**
 * Parses a `key=value` pair collected from a repeatable flag (`--field`).
 * Values are passed through `JSON.parse` when they look like JSON so numbers
 * and booleans survive as their own types in `mergeFields`, since the API
 * accepts arbitrary JSON there and merge values are not all strings.
 */
export function parseKeyValue(pairs: string[] | undefined): Record<string, unknown> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;

  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new FlagError(`--field expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    out[key] = coerceScalar(raw);
  }
  return out;
}

function coerceScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** commander's `collect` helper for repeatable flags (`--tag a --tag b`). */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
