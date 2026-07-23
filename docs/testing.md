# Testing

Two suites, two `vitest` configs, on purpose. The Mongo repositories are verified against a real
database, but not by making the default suite slower or DB-dependent — the two suites split that work.

## `npm test` — the default suite (fast, no DB)

`vitest.config.ts`. Use cases and routes are exercised via DI-rebound `InMemory<X>Repository` doubles
(ADR-003) — no live database, no network, sub-second. This is what CI runs on every PR
(`.github/workflows/ci.yml`) and stays the fast inner-loop suite for day-to-day development.

## `npm run test:integration` — repository contract tests (real Mongo, slower)

`vitest.integration.config.ts`, `src/**/*.integration.test.ts`. Runs each `Mongo<X>Repository` against
a **real `mongod`**, asserting the same behavioral contract its sibling `InMemory<X>Repository` is
checked against in the default suite — so both are trusted stand-ins for the repository interface, not
just the in-memory one. Deliberately kept out of `npm test` (and out of CI's PR gate, for now) so the
fast suite stays fast and dependency-free; run it explicitly, or wire it into CI as a separate,
non-blocking job later.

### Why `mongodb-memory-server`, not testcontainers

Both were realistic options. Picked `mongodb-memory-server`:

- **No Docker.** It downloads and runs a real `mongod` binary directly (cached under
  `~/.cache/mongodb-binaries` after the first run) — testcontainers needs a working Docker daemon in
  every environment that runs it, including CI runners and contributors' machines. This repo's own
  deployment story (ADR-009) is already "Docker as a build/runtime artifact," not "Docker as a dev-time
  dependency," so not requiring it here keeps that story consistent.
- **Standalone mode**, not a replica set: `MongoMemoryServer` (a bare `mongod`). With the native
  driver and cablegram's single-document, no-transaction writes (ADR-012), a replica set buys nothing
  — and running the contract tests against a plain standalone is exactly what **proves** the app needs
  no replica-set topology in production. (The earlier Prisma-era wiring used `MongoMemoryReplSet`
  because Prisma's Mongo connector required one; that requirement went away with the swap. If a future
  use case ever needs a multi-document transaction, this is the first place it would fail — and the
  signal to reintroduce a replica set.)
- **CI-friendly and fast enough.** One `mongod` process, no network pull of a container image, no
  daemon-in-daemon concerns on hosted runners.

### How it's wired

- `src/shared/testing/` — a genuine `shared/*` leaf module (ADR-005 #4: it imports no domain component),
  never imported by production code. `mongo-memory.ts` starts the standalone `mongod`.
- `src/shared/testing/global-setup.ts` — a Vitest [`globalSetup`](https://vitest.dev/config/#globalsetup)
  hook, wired only into `vitest.integration.config.ts`. Starts **one** standalone `mongod` for the
  whole integration run (booting one costs a few seconds; sharing it across every contract test file
  avoids paying that per file), creates the indexes on it once via `ensureIndexes` (`shared/persistence`
  — the same bootstrap production runs, ADR-012, now that Prisma's `db push` is gone), and hands the
  connection string to every test file via Vitest's `provide`/`inject` — not an environment variable,
  so it stays type-checked at both ends
  (`declare module 'vitest' { interface ProvidedContext { mongoUri: string } }`).
- Each `*.integration.test.ts` file builds its **own** `MongoClient` from `inject('mongoUri')`,
  constructs the repository under test directly with the connected `Db` (`new MongoXRepository(db)` —
  no DI container needed, the class doesn't require one to be instantiated), and truncates its
  collection in `afterEach` so tests stay independent despite sharing one database.
- `fileParallelism: false` in `vitest.integration.config.ts`: every file shares the one `mongod`, so
  files run serially — a concurrent file's `afterEach` truncation can't race another file's assertions.

### Running it

```bash
npm run test:integration
```

First run downloads the `mongod` binary (network required); subsequent runs reuse the cache. No
`DATABASE_URL` to set — the harness starts its own database and points the tests at it.

## Not yet covered

- **No wired end-to-end suite.** Nothing yet boots the real composition root + real Mongo and drives
  the full journey (newsletter → subscribe → template → campaign → send → simulated webhook) through
  HTTP. This is the highest-value gap — it's what would catch cross-layer breaks the unit and
  isolated-repo tests can't.
- **No live smoke test.** A Docker container serving `/health`, a real send via Postmark's **test
  token**, and a real webhook round-trip (via an ngrok tunnel) are manual/pending.
- **CI runs unit tests only.** Extending the GitHub Action to also run `test:integration` (and a
  future e2e) is pending.
