import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.js';
import { toImportRow } from './commands/subscriptions.js';

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

describe('toImportRow', () => {
  it('splits tags on semicolons, not commas', () => {
    // A comma would collide with the CSV delimiter — the exact paper cut that
    // makes an import quietly wrong.
    const { row } = toImportRow({ email: 'a@example.com', tags: 'vip; beta ;' });

    expect(row.tags).toEqual(['vip', 'beta']);
  });

  it('maps every other column into mergeFields', () => {
    const { row } = toImportRow({
      email: 'a@example.com',
      firstname: 'Ada',
      city: '',
    });

    // Empty cells are dropped rather than stored as empty strings.
    expect(row.mergeFields).toEqual({ firstname: 'Ada' });
  });

  it('preserves merge-field casing so {{firstName}} keeps working', () => {
    // Regression: lowercasing headers made a `firstName` column arrive as
    // `firstname`, silently breaking every {{firstName}} placeholder in a
    // template — a failure that only shows up in already-sent mail.
    const { row } = toImportRow({ email: 'a@example.com', firstName: 'Ada' });

    expect(row.mergeFields).toEqual({ firstName: 'Ada' });
  });

  it('still matches the reserved columns case-insensitively', () => {
    const { row } = toImportRow({
      Email: 'a@example.com',
      Tags: 'vip',
      Status: 'unsubscribed',
      SubscribedAt: '2019-04-02',
    });

    expect(row.email).toBe('a@example.com');
    expect(row.tags).toEqual(['vip']);
    expect(row.status).toBe('unsubscribed');
    expect(row.subscribedAt).toBe('2019-04-02T00:00:00.000Z');
    // The reserved columns must not leak into merge fields under their
    // original casing either.
    expect(row.mergeFields).toBeUndefined();
  });

  it('flags an invalid address instead of sending it', () => {
    const parsed = toImportRow({ email: 'not-an-email' });

    expect(parsed.error).toMatch(/not a valid email/);
  });

  it('omits everything optional when the row carries none of it', () => {
    const { row } = toImportRow({ email: 'a@example.com' });

    expect(row).toEqual({
      email: 'a@example.com',
      status: undefined,
      tags: undefined,
      mergeFields: undefined,
      source: undefined,
    });
  });

  it('carries every status in the vocabulary through verbatim', () => {
    for (const status of ['pending', 'subscribed', 'unsubscribed', 'bounced', 'complained']) {
      expect(toImportRow({ email: 'a@example.com', status }).row.status).toBe(status);
    }
  });

  it('accepts a status in any casing', () => {
    // Spreadsheets title-case things; that must not fail an 18k-row migration.
    expect(toImportRow({ email: 'a@example.com', status: 'Unsubscribed' }).row.status).toBe(
      'unsubscribed',
    );
  });

  it('fails a row with an unknown status rather than defaulting it', () => {
    // Defaulting here would quietly turn someone's opt-out into a `subscribed`
    // — the single worst thing an import can do.
    const parsed = toImportRow({ email: 'a@example.com', status: 'cleaned' });

    expect(parsed.error).toMatch(/not a valid status/);
    expect(parsed.row.status).toBeUndefined();
  });

  it('leaves the status unset when the column is empty, for the batch default', () => {
    expect(toImportRow({ email: 'a@example.com', status: '  ' }).row.status).toBeUndefined();
  });

  it('treats source as a reserved column, not a merge field', () => {
    // A `{{source}}` placeholder that renders into a campaign is not what an
    // operator means by a `source` column — it is metadata about the record.
    const { row } = toImportRow({ email: 'a@example.com', source: 'mailchimp-2026' });

    expect(row.source).toBe('mailchimp-2026');
    expect(row.mergeFields).toBeUndefined();
  });

  it('reserves the consent-trail columns so an opt-in IP is never a merge field', () => {
    // Letting these fall through would both lose the record and make a
    // subscriber's IP renderable into a campaign body.
    const { row } = toImportRow({
      email: 'a@example.com',
      signupIp: '203.0.113.1',
      confirmedAt: '2019-04-02T09:20:00Z',
      confirmedIp: '203.0.113.1',
      unsubscribedAt: '2021-01-05',
      unsubscribedUserAgent: 'Thunderbird/115',
    });

    expect(row.signupIp).toBe('203.0.113.1');
    expect(row.confirmedAt).toBe('2019-04-02T09:20:00.000Z');
    expect(row.confirmedIp).toBe('203.0.113.1');
    expect(row.unsubscribedAt).toBe('2021-01-05T00:00:00.000Z');
    expect(row.unsubscribedUserAgent).toBe('Thunderbird/115');
    expect(row.mergeFields).toBeUndefined();
  });

  it('names which date column is bad so an 18k-row file is fixable', () => {
    const parsed = toImportRow({ email: 'a@example.com', confirmedAt: 'whenever' });

    expect(parsed.error).toMatch(/not a valid date \(confirmedAt\)/);
  });

  it('fails a row whose subscribedAt is not a date', () => {
    const parsed = toImportRow({ email: 'a@example.com', subscribedAt: 'last tuesday' });

    expect(parsed.error).toMatch(/not a valid date/);
  });
});
