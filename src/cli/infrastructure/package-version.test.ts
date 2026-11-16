import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageVersion } from './package-version.js';

describe('readPackageVersion (#63)', () => {
  it("reports this package's own version, so --version cannot drift from a release", () => {
    // Read independently of the module, so a wrong relative path fails here.
    const expected = (
      JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(readPackageVersion()).toBe(expected);
    expect(readPackageVersion()).not.toBe('0.1.0');
  });

  it('refuses a package.json with no version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cablegram-version-'));
    const file = join(dir, 'package.json');
    writeFileSync(file, JSON.stringify({ name: 'cablegram' }));
    expect(() => readPackageVersion(pathToFileURL(file))).toThrow(/No version field/);
  });
});
