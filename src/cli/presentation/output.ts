/**
 * Terminal rendering (ADR-016 §3). Two modes, and the split matters:
 *
 * - `--json` prints the **raw API body**, unreshaped. That is the scriptable
 *   contract, and it is the API's DTO rather than a CLI invention — so `jq`
 *   expressions written against the API work unchanged against the CLI.
 * - the default is a human table, which is free to drop and reorder columns.
 *
 * Anything the operator did not ask for (progress, confirmations, warnings)
 * goes to **stderr**, so `cablegram ... --json > out.json` is always a clean
 * document.
 */

export interface OutputOptions {
  json: boolean;
  /** Colour is suppressed when not a TTY, or when NO_COLOR is set. */
  color: boolean;
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
} as const;

export function resolveOutputOptions(json: boolean, stream: NodeJS.WriteStream = process.stdout): OutputOptions {
  // https://no-color.org — any non-empty value disables colour.
  const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';
  return { json, color: !json && !noColor && stream.isTTY === true };
}

export class Printer {
  constructor(
    private readonly options: OutputOptions,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    private readonly stderr: NodeJS.WritableStream = process.stderr,
  ) {}

  get isJson(): boolean {
    return this.options.json;
  }

  private paint(text: string, code: string): string {
    return this.options.color ? `${code}${text}${ANSI.reset}` : text;
  }

  /** The primary result of a command. In `--json` mode this is the only output. */
  data(value: unknown): void {
    if (this.options.json) {
      this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }
  }

  /** A line of human output; suppressed entirely in `--json` mode. */
  line(text = ''): void {
    if (!this.options.json) this.stdout.write(`${text}\n`);
  }

  /** Success note — stderr, so it never contaminates piped output. */
  success(text: string): void {
    if (!this.options.json) this.stderr.write(`${this.paint('✓', ANSI.green)} ${text}\n`);
  }

  warn(text: string): void {
    this.stderr.write(`${this.paint('!', ANSI.yellow)} ${text}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${this.paint('✗', ANSI.red)} ${text}\n`);
  }

  dim(text: string): void {
    if (!this.options.json) this.stderr.write(`${this.paint(text, ANSI.dim)}\n`);
  }

  /**
   * Renders a list. `--json` emits the API envelope verbatim (including
   * `meta.nextCursor`, which a script needs to page); the table shows only the
   * chosen columns, with the cursor hint on stderr.
   */
  table<T>(envelope: { data: T[]; meta?: { nextCursor: string | null } }, columns: Column<T>[]): void {
    if (this.options.json) {
      this.data(envelope);
      return;
    }

    if (envelope.data.length === 0) {
      this.dim('No results.');
      return;
    }

    const rows = envelope.data.map((row) => columns.map((c) => c.value(row)));
    const widths = columns.map((column, i) =>
      Math.max(column.header.length, ...rows.map((row) => (row[i] ?? '').length)),
    );

    const renderRow = (cells: string[]): string =>
      cells
        .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd();

    this.line(this.paint(renderRow(columns.map((c) => c.header.toUpperCase())), ANSI.bold));
    for (const row of rows) this.line(renderRow(row));

    if (envelope.meta?.nextCursor != null) {
      this.dim(`More results — pass --cursor ${envelope.meta.nextCursor} (or --all).`);
    }
  }

  /** Renders a single record as aligned `key: value` pairs. */
  detail(record: Record<string, unknown>, raw?: unknown): void {
    if (this.options.json) {
      this.data(raw ?? record);
      return;
    }

    const keys = Object.keys(record);
    const width = Math.max(...keys.map((k) => k.length));
    for (const key of keys) {
      this.line(`${this.paint(key.padStart(width), ANSI.dim)}  ${format(record[key])}`);
    }
  }
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
}

/** Renders a cell value: nullish reads as an em dash, dates as short ISO. */
export function format(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Trims an ISO timestamp to `YYYY-MM-DD HH:MM` for table display. */
export function shortDate(iso: string | null | undefined): string {
  if (iso == null) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 16).replace('T', ' ');
}

/** Truncates a long value so a table row stays on one terminal line. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
