import { readFileSync } from 'node:fs';

/**
 * The version of the installed `cablegram` package, read from its own
 * `package.json` at run time (#63).
 *
 * It used to be a hand-written constant, which release-please never touched:
 * every release since 1.0 printed `0.1.0`. Reading the file the package ships
 * with means `--version` can only ever report what is actually installed.
 *
 * The path is relative to this module, and it is the same from the source
 * (`src/cli/infrastructure/`) and the build (`dist/cli/infrastructure/`): both
 * sit three levels below the package root, where npm always includes
 * `package.json` in the published tarball.
 */
export function readPackageVersion(
  packageJsonUrl: URL = new URL('../../../package.json', import.meta.url),
): string {
  const pkg = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`No version field in ${packageJsonUrl.pathname}`);
  }
  return pkg.version;
}
