#!/usr/bin/env node
import type { CliDeps } from './application/deps.js';
import { FetchApiClient } from './infrastructure/fetch-api-client.js';
import { FileCredentialStore } from './infrastructure/file-credential-store.js';
import { run } from './presentation/program.js';

/**
 * The `cablegram` binary (ADR-016 §2).
 *
 * This file is the CLI's composition root — the one place that names concrete
 * implementations. `presentation/` may not import `infrastructure/` (ADR-005),
 * so the wiring has to happen here, in the component element. It is plain
 * constructor injection rather than an Inversify container: the whole graph is
 * a credential store and a client factory, built once (ADR-003 exists for the
 * server's request-scoped, Mongo-backed graph, which this process does not have).
 */
const store = new FileCredentialStore();

const deps: CliDeps = {
  store,
  createClient: (credentials) => new FetchApiClient(credentials, store),
  now: () => new Date(),
};

const exitCode = await run(deps, process.argv.slice(2));

// Set rather than `process.exit()`: exiting immediately can truncate stdout
// when it is a pipe, which would corrupt `--json` output mid-document.
process.exitCode = exitCode;
