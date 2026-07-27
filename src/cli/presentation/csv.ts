/**
 * A minimal RFC 4180 CSV reader for `subscriptions import` (ADR-016).
 *
 * Hand-rolled rather than added as a dependency: the CLI reads one shape of
 * file, and the rules that actually matter for a subscriber list are quoted
 * fields (an address or a merge value containing a comma), doubled quotes
 * inside a quoted field, and CRLF line endings from a spreadsheet export.
 * A parser that handles those three is a few dozen lines; a dependency that
 * handles streaming, custom delimiters, and type coercion is not worth carrying
 * for it.
 *
 * Deliberately *not* supported: alternate delimiters and embedded newlines
 * inside quoted fields. Both are rejected loudly rather than mis-parsed, since a
 * silently mangled import is far worse than a refused one.
 */

export class CsvError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'CsvError';
  }
}

/** Splits one CSV line into fields, honoring quotes and doubled escapes. */
export function parseLine(line: string, lineNumber: number): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0) {
        throw new CsvError('unexpected quote in the middle of a field', lineNumber);
      }
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new CsvError('unterminated quote (embedded newlines are not supported)', lineNumber);
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/**
 * Parses a whole CSV document into header-keyed rows. Blank lines are skipped
 * (trailing newlines are near-universal in exports); a row whose field count
 * disagrees with the header is an error, because the most likely cause is an
 * unquoted comma and guessing would corrupt the data.
 *
 * Header **casing is preserved**. It would be convenient to lowercase them so
 * `Email` and `email` both match, but every non-reserved column becomes a merge
 * field, and custom fields are referenced by name in templates — lowercasing
 * would turn a `firstName` column into `{{firstname}}` and silently break every
 * `{{firstName}}` placeholder. Callers match the reserved columns
 * case-insensitively instead (see `column`).
 */
export function parseCsv(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/);
  const headerLine = lines.find((line) => line.trim().length > 0);
  if (headerLine === undefined) throw new CsvError('the file is empty');

  const headers = parseLine(headerLine, 1);
  const rows: Record<string, string>[] = [];

  for (let i = lines.indexOf(headerLine) + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;

    const fields = parseLine(line, i + 1);
    if (fields.length !== headers.length) {
      throw new CsvError(
        `expected ${headers.length} fields, found ${fields.length} — check for an unquoted comma`,
        i + 1,
      );
    }

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = fields[index] ?? '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Reads a reserved column (`email`, `tags`) case-insensitively, so a
 * spreadsheet's `Email` header works while merge-field names keep their casing.
 * Returns the matched key too, so the caller can exclude it from custom fields.
 */
export function column(
  row: Record<string, string>,
  name: string,
): { key: string; value: string } | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === target) return { key, value };
  }
  return null;
}
