import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileCredentialStore, defaultConfigPath } from './file-credential-store.js';

/**
 * The config file holds a live refresh token (ADR-016 §5), so the permission
 * assertions here are the point of the suite, not incidental detail.
 */

async function tempStore(): Promise<{ store: FileCredentialStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cablegram-cli-'));
  const path = join(dir, 'nested', 'config.json');
  return { store: new FileCredentialStore(path), path };
}

describe('FileCredentialStore', () => {
  it('round-trips credentials, creating the directory', async () => {
    const { store } = await tempStore();
    const credentials = {
      baseUrl: 'https://api.example.com',
      accessToken: 'a',
      refreshToken: 'r',
    };

    await store.save(credentials);

    expect(await store.load()).toEqual(credentials);
  });

  it('writes the file 0600 and its directory 0700', async () => {
    const { store, path } = await tempStore();
    await store.save({ baseUrl: 'https://api.example.com', refreshToken: 'r' });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
  });

  it('tightens the permissions of a pre-existing loose file', async () => {
    const { store, path } = await tempStore();
    await store.save({ baseUrl: 'https://api.example.com' });
    // Simulate a config loosened by hand, or written before this rule existed.
    await writeFile(path, '{}', { mode: 0o644 });
    const { chmod } = await import('node:fs/promises');
    await chmod(path, 0o644);

    await store.save({ baseUrl: 'https://api.example.com', refreshToken: 'r' });

    // writeFile's `mode` only applies on creation, so without the explicit
    // chmod this file would stay world-readable.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('treats a missing file as "not logged in", not an error', async () => {
    const { store } = await tempStore();

    expect(await store.load()).toBeNull();
  });

  it('treats a config with no base URL as absent', async () => {
    const { store, path } = await tempStore();
    await store.save({ baseUrl: 'https://x.example' });
    await writeFile(path, JSON.stringify({ accessToken: 'orphan' }));

    expect(await store.load()).toBeNull();
  });

  it('reports a corrupt file instead of looking like a mysterious logout', async () => {
    const { store, path } = await tempStore();
    await store.save({ baseUrl: 'https://x.example' });
    await writeFile(path, 'not json at all');

    await expect(store.load()).rejects.toThrow(/not valid JSON/);
  });

  it('clears idempotently', async () => {
    const { store } = await tempStore();
    await store.save({ baseUrl: 'https://x.example' });

    await store.clear();
    await expect(store.clear()).resolves.toBeUndefined();
    expect(await store.load()).toBeNull();
  });

  it('does not leave a trailing-newline-free file (POSIX text convention)', async () => {
    const { store, path } = await tempStore();
    await store.save({ baseUrl: 'https://x.example' });

    expect(await readFile(path, 'utf8')).toMatch(/\n$/);
  });
});

describe('defaultConfigPath', () => {
  it('prefers CABLEGRAM_CONFIG', () => {
    expect(defaultConfigPath({ CABLEGRAM_CONFIG: '/custom/c.json' })).toBe('/custom/c.json');
  });

  it('honors XDG_CONFIG_HOME', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/cablegram/config.json');
  });

  it('falls back to ~/.config', () => {
    expect(defaultConfigPath({})).toMatch(/\.config\/cablegram\/config\.json$/);
  });
});
