import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import * as library from './index.js';
import type { AppConfig, AppEnv } from './index.js';
import { buildContainer } from './shared/di/index.js';
import { TEST_ENV } from './shared/testing/index.js';

/**
 * The guard rail on the library entrypoint (ADR-027).
 *
 * `src/index.ts` is the package's `"."` export, so its named exports are the
 * published API surface — the one part of this codebase where a rename is a
 * breaking change for someone else's build rather than a refactor. The set is
 * therefore frozen here on purpose: adding a symbol should require editing this
 * list (a `feat:`), and removing one should require editing it *and* a `!`.
 */

// Every value the package promises at `import ... from 'cablegram'`.
const PUBLIC_SURFACE = [
  'ALL_INDEXES',
  'TYPES',
  'buildContainer',
  'createApp',
  'ensureIndexes',
] as const;

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  exports: Record<string, { types?: string; default?: string } | string>;
};

describe('the library entrypoint', () => {
  it('exports exactly the documented public surface', () => {
    // Sorted so the diff on a failure names the symbol, not the ordering.
    expect(Object.keys(library).sort()).toEqual([...PUBLIC_SURFACE].sort());
  });

  it('exports no domain internals', () => {
    // The line ADR-004/ADR-016 draw: a host mounts the HTTP surface, it does not
    // reach past it. A use case, entity or repository appearing here would make
    // an embedding host a second delivery mechanism.
    const leaked = Object.keys(library).filter((name) => /Repository|UseCase|Gateway$/.test(name));
    expect(leaked).toEqual([]);
  });

  it('keeps the type-only exports resolvable', () => {
    // Referencing both in type position is the assertion — `npm run typecheck`
    // fails if either is dropped from the barrel, which `Object.keys` cannot see.
    const config: AppConfig | undefined = undefined;
    const env: AppEnv | undefined = undefined;
    expect([config, env]).toEqual([undefined, undefined]);
  });

  it('is wired as the package’s "." export, with types', () => {
    // The failure this catches is the published one from issue #44:
    // ERR_PACKAGE_PATH_NOT_EXPORTED, or a TS consumer on NodeNext getting `any`.
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });

  it('exposes no provider-specific entrypoint', () => {
    // The DO Functions handler was the package's only entrypoint until
    // ADR-028 retired the target. What replaced it is provider-neutral: a
    // barrel any long-running host mounts. A new `./<provider>` export would
    // be the old shape growing back.
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json']);
  });
});

describe('an app mounted under a host prefix', () => {
  // The whole point of the entrypoint: `createApp` returns a value a host can
  // `route()` under a prefix of its choosing, with the prefix stripped before
  // cablegram's own routing sees the path.
  // Both routes are registered up front: Hono builds its matcher on the first
  // request and rejects additions afterwards.
  const host = new Hono();
  host.get('/', (c) => c.text('host'));
  host.route('/newsletter', library.createApp(buildContainer(TEST_ENV)));

  it('serves its routes under the prefix', async () => {
    const res = await host.request('/newsletter/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'cablegram' });
  });

  it('leaves the host to serve everything outside the prefix', async () => {
    expect(await (await host.request('/')).text()).toBe('host');
  });

  // The gate's own behaviour under a mount — open stays open, gated stays
  // gated — is pinned next to its subject, in `app.test.ts`.
});
