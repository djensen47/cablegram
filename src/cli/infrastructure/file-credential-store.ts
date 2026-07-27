import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CredentialStore, StoredCredentials } from '../application/credential-store.js';

/**
 * Resolves the config path, honoring `XDG_CONFIG_HOME` and an explicit
 * `CABLEGRAM_CONFIG` override (which CI and the tests use to stay well away
 * from a real operator's session).
 */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CABLEGRAM_CONFIG;
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'cablegram', 'config.json');
}

/**
 * Stores the CLI session as JSON on disk (ADR-016 §5).
 *
 * The file holds a **live refresh token** — a bearer credential that mints
 * sessions until it is revoked — so the permissions are set explicitly rather
 * than left to the process umask: `0600` on the file inside a `0700` directory,
 * the same posture as `~/.aws/credentials` or `gh`'s hosts.yml. `writeFile`'s
 * `mode` only applies when it creates the file, so an existing file is
 * `chmod`ed on every save; that keeps a file that predates this rule (or was
 * loosened by hand) from silently staying world-readable.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string = defaultConfigPath()) {}

  location(): string {
    return this.path;
  }

  async load(): Promise<StoredCredentials | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object') return null;
      const { baseUrl } = parsed as StoredCredentials;
      // A config without a base URL cannot address a deployment; treat it as
      // absent rather than half-usable.
      return typeof baseUrl === 'string' && baseUrl.length > 0
        ? (parsed as StoredCredentials)
        : null;
    } catch (err) {
      // Missing file is the normal pre-login state, not an error. A corrupt
      // file is reported, because silently ignoring it would look like a
      // mysterious logout.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        throw new Error(`Config at ${this.path} is not valid JSON — delete it and log in again.`);
      }
      throw err;
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
