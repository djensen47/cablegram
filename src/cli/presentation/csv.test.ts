import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.js';
import { toSubscribeBody } from './commands/subscriptions.js';

/**
 * The import path is the one place a CLI bug silently corrupts an operator's
 * subscriber list, so these lean on the cases a spreadsheet export actually
 * produces — quoted commas, CRLF, trailing blank lines — and on refusing
 * anything ambiguous.
 */

describe('parseCsv', () => {
  it('reads a header and rows, preserving header casing', async () => {
    const rows = parseCsv('Email,Tags\nada@example.com,vip;beta\n');

    expect(rows).toEqual([{ Email: 'ada@example.com', Tags: 'vip;beta' }]);
  });

  it('handles CRLF line endings and trailing blank lines', () => {
    const rows = parseCsv('email\r\na@example.com\r\nb@example.com\r\n\r\n');

    expect(rows.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('keeps a comma inside a quoted field', () => {
    const rows = parseCsv('email,company\na@example.com,"Acme, Inc."\n');

    expect(rows[0]?.company).toBe('Acme, Inc.');
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('email,note\na@example.com,"She said ""hi"""\n');

    expect(rows[0]?.note).toBe('She said "hi"');
  });

  it('refuses a row whose field count disagrees with the header', () => {
    // The overwhelmingly likely cause is an unquoted comma; guessing which
    // field it belongs to would corrupt the import.
    expect(() => parseCsv('email,name\na@example.com,Ada,extra\n')).toThrow(CsvError);
  });

  it('refuses an unterminated quote rather than swallowing the rest of the file', () => {
    expect(() => parseCsv('email\n"a@example.com\n')).toThrow(/unterminated quote/);
  });

  it('reports the line number of a bad row', () => {
    const err = (() => {
      try {
        parseCsv('email,name\na@example.com,Ada\nb@example.com,B,oops\n');
      } catch (e) {
        return e as CsvError;
      }
    })();

    expect(err?.message).toContain('line 3');
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv('   \n')).toThrow(/empty/);
  });
});

describe('toSubscribeBody', () => {
  it('splits tags on semicolons, not commas', () => {
    // A comma would collide with the CSV delimiter — the exact paper cut that
    // makes an import quietly wrong.
    const { body } = toSubscribeBody({ email: 'a@example.com', tags: 'vip; beta ;' });

    expect(body.tags).toEqual(['vip', 'beta']);
  });

  it('maps every other column into mergeFields', () => {
    const { body } = toSubscribeBody({
      email: 'a@example.com',
      firstname: 'Ada',
      city: '',
    });

    // Empty cells are dropped rather than stored as empty strings.
    expect(body.mergeFields).toEqual({ firstname: 'Ada' });
  });

  it('preserves merge-field casing so {{firstName}} keeps working', () => {
    // Regression: lowercasing headers made a `firstName` column arrive as
    // `firstname`, silently breaking every {{firstName}} placeholder in a
    // template — a failure that only shows up in already-sent mail.
    const { body } = toSubscribeBody({ email: 'a@example.com', firstName: 'Ada' });

    expect(body.mergeFields).toEqual({ firstName: 'Ada' });
  });

  it('still matches the reserved columns case-insensitively', () => {
    const { body } = toSubscribeBody({ Email: 'a@example.com', Tags: 'vip' });

    expect(body.email).toBe('a@example.com');
    expect(body.tags).toEqual(['vip']);
    // The reserved columns must not leak into merge fields under their
    // original casing either.
    expect(body.mergeFields).toBeUndefined();
  });

  it('flags an invalid address instead of sending it', () => {
    const row = toSubscribeBody({ email: 'not-an-email' });

    expect(row.error).toMatch(/not a valid email/);
  });

  it('omits tags and mergeFields entirely when there are none', () => {
    const { body } = toSubscribeBody({ email: 'a@example.com' });

    expect(body).toEqual({ email: 'a@example.com', tags: undefined, mergeFields: undefined });
  });
});
