/**
 * The library entrypoint (ADR-027) — the `"."` export of the published package.
 *
 * cablegram has two supported consumption modes, and this is the second one:
 * a long-running host service builds the container, opens the pool, ensures the
 * indexes, and mounts the Hono app under a path prefix of its own choosing.
 * (The first is `cablegram/function`, the DigitalOcean Functions handler —
 * ADR-009.) Both run the *same* app; only the host differs, so this is not a
 * second delivery mechanism in the ADR-004 sense.
 *
 * ```ts
 * import { buildContainer, createApp, TYPES, ensureIndexes, ALL_INDEXES } from 'cablegram';
 *
 * const container = buildContainer(env);        // env must carry BASE_URL *including* the mount prefix
 * await container.get<MongoClient>(TYPES.MongoClient).connect();
 * await ensureIndexes(container.get<Db>(TYPES.MongoDb), ALL_INDEXES);
 * host.route('/newsletter', createApp(container));
 * ```
 *
 * What is exported here is a **contract**, not a convenience: everything named
 * below is public API and subject to ADR-026's conventional-commit versioning.
 * Adding a symbol is a `feat:`; removing or renaming one is a breaking change.
 * The rule for what belongs here is narrow — a host needs exactly enough to
 * *bootstrap and mount* the API. Use cases, repositories, entities and DTOs are
 * deliberately absent: reaching past the HTTP surface into the domain would
 * make an embedding host a second delivery mechanism, which is the line ADR-004
 * and ADR-016 both draw. See `docs/embedding.md`.
 */

// The mountable Hono app. `OpenAPIHono` extends `Hono`, so `host.route(prefix, app)`
// and `app.fetch` both work on the returned value.
export { createApp } from './app.js';

// The composition root and its tokens. `buildContainer(env)` takes a plain env
// object (defaults to `process.env`), so a host can pass its own config.
export { buildContainer, TYPES } from './shared/di/index.js';

// Index bootstrap. The native driver has no `db push` (ADR-012), so the app
// owns index creation and a host must run it at startup, once.
export { ensureIndexes, type CollectionIndexes } from './shared/persistence/index.js';
export { ALL_INDEXES } from './indexes.js';

// Types a host touches while wiring the above: the resolved config it can read
// back off the container (`TYPES.Config`) and the Hono env the app is generic
// over, which a host needs to type its own middleware around the mount point.
export type { AppConfig } from './shared/config/index.js';
export type { AppEnv } from './shared/http/index.js';
