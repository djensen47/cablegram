# ADR-017: Component-Owned Collections & the `<component>_<aggregate>` Naming Rule

## Status

Accepted — 2026-07-26. Amends the collection-naming clause of
[ADR-012](ADR-012-persistence-mongodb-native-driver.md).

## Context

Every MongoDB collection in cablegram belongs to exactly one bounded context
([ADR-011](ADR-011-bounded-contexts.md)), and that ownership is real: each collection is read and
written by precisely one component's repository, cross-component access goes through facades, and the
boundary rules ([ADR-005](ADR-005-boundary-enforcement.md)) make a sibling's repository unreachable.

Two things contradicted that ownership.

### 1. The schema lived in a `shared/*` leaf

`shared/persistence/collections.ts` held all nine collection names, and `ensure-indexes.ts` hard-coded
the index requirements of **six** domain components — the `subscriptions` membership key, the
`accounts` TTL sweeps, the `campaigns` listing indexes. So a `shared/*` module, which by ADR-005 #4 is
a leaf that may not even *import* a domain component, encoded those components' storage schema. A
change to how `subscriptions` indexes its membership key meant editing a shared file, and nothing in
`subscriptions/` revealed that the collection or its unique constraint existed at all.

This is the same failure package-by-component ([ADR-002](ADR-002-package-by-component.md)) exists to
prevent, and it had simply been missed because index creation arrived late — it only became the app's
job when ADR-012 removed Prisma's `db push`, and the mechanical translation put it wherever the Mongo
bootstrap already lived.

### 2. The names were opaque, and inherited rather than chosen

Collection names were bare aggregate plurals: `newsletters`, `send_records`, `suppressions`, `users`.
ADR-012 kept them deliberately — they were "the same names Prisma's `@@map(...)` produced before the
swap, so an existing database keeps working unchanged." A compatibility decision, not a naming
decision, and it was never revisited.

The cost shows up wherever there is no code to read. `send_records` in a `show collections` listing, a
slow-query log, an Atlas alert, or a backup manifest tells you nothing — not what it holds, not what
owns it. Worse, ownership was **underivable even in principle**: `suppressions` is owned by
`deliverability` and `users` by `accounts`, so the name is not merely unqualified, it is misleading.

Two options were considered and rejected:

- **Prefix only the opaque names.** Attractive, because opacity and prefix-stutter turn out to be
  inversely correlated: names that stutter when prefixed (`newsletters`, `campaigns`) are exactly the
  ones already self-describing, since a component named after its root aggregate means the root's name
  *is* the domain concept. But the rule becomes "prefix, except when it duplicates" — a conditional
  convention that must be re-argued at every new collection.
- **Don't prefix; let code express ownership.** Fixing (1) does make ownership structural, so the name
  need not carry it. But that only serves someone reading the source. It does nothing for the operator
  looking at a collection list, which is precisely where the confusion bites.

Nothing is deployed yet — the first real import had not run — so ADR-012's compatibility clause
protects a database that does not exist, and renaming costs nothing.

## Decision

### 1. Each component owns its collection names and its indexes

Every component declares, in its own `infrastructure/collections.ts`:

- a `<COMPONENT>_COLLECTIONS` constant — the names it owns, the single source its repositories use;
- a `<component>Indexes: CollectionIndexes[]` — the indexes those collections need.

Both are exported from the component facade. `shared/persistence` keeps only the *mechanism*:

```ts
export interface CollectionIndexes { collection: string; indexes: readonly IndexDescription[] }
export async function ensureIndexes(db: Db, specs: readonly CollectionIndexes[]): Promise<void>
```

`ensureIndexes` now knows **no collection name**, which makes `shared/persistence` a genuine leaf.
`shared/persistence/collections.ts` is **deleted**.

A component whose collections need no declared index still registers them with `indexes: []` (skipped
at creation time). Declaring it is what makes the component's storage footprint discoverable from the
component, rather than invisible because it happens to need nothing.

### 2. Assembly is explicit, at the app layer

`src/indexes.ts` concatenates the per-component specs into `ALL_INDEXES`, consumed by `server.ts`,
`function.ts`, and the integration setup.

This mirrors `app.ts` mounting each component's router: composition visible in one place, content owned
by each component. It is deliberately **not** DI multi-binding — reading specs out of the container
would require a fully-built container, which requires `loadConfig` to validate a complete environment,
which the integration setup does not have and should not need in order to create an index.

The integration `globalSetup` **moves** from `shared/testing/global-setup.ts` to
`src/integration-setup.ts`. It needs `ALL_INDEXES`, which imports component facades; a `shared/*`
module may not (ADR-005 #4). At `src/` it is an `app` element — the same category as the other two
entrypoints, which is what it is. This keeps the integration suite creating the *real* index set rather
than a parallel copy that could drift.

### 3. Collections are named `<singular component>_<aggregate>`

| collection | owner |
|---|---|
| `newsletter_newsletters` | newsletters |
| `subscription_subscriptions` | subscriptions |
| `template_templates` | templates |
| `campaign_campaigns` | campaigns |
| `campaign_send_records` | campaigns |
| `deliverability_suppressions` | deliverability |
| `account_users` | accounts |
| `account_refresh_tokens` | accounts |
| `account_one_time_tokens` | accounts |

**Applied uniformly, stutter included.** `template_templates` reads oddly, and that was accepted
knowingly: a rule with **no exceptions** is worth more than four avoided repetitions. Every name now
identifies its owning context with no code, no lookup table, and no judgment call at the next
collection.

### 4. The checklist becomes an assertion

Per-component declaration buys ownership but loses something real: a single shared file made "did you
forget an index?" answerable by reading it. Now a component can declare a collection and forget to
register it, and the failure is silent and expensive — an unindexed `(newsletterId, email)` lookup is a
full collection scan on every subscribe.

`src/indexes.test.ts` therefore asserts that the registry (a) covers every collection every component
owns, (b) contains no orphan left behind by a rename, (c) declares each collection exactly once, (d)
gives each collection a single owner, and (e) follows the naming rule. Integration-test cleanup was
also switched from string literals to the component constants — a literal would have silently truncated
a *nonexistent* collection after the rename, leaking state between files instead of failing.

## Consequences

- **`shared/persistence` is finally the leaf ADR-005 claims it is.** It carries mechanism, not
  schema, and imports nothing domain-shaped.
- **A collection is discoverable from its owner.** Reading `subscriptions/infrastructure/` now tells
  you it owns one collection with a unique membership key. Previously that fact lived two directories
  away in a shared file.
- **Names are self-describing in the places that have no code** — shells, slow-query logs, Atlas
  alerts, backup manifests. That was the whole point; the code-level fix in §1 does not deliver it.
- **`template_templates` is ugly.** Accepted. The alternative was a conditional rule needing a
  judgment call per collection, which is worse than a predictable ugly one.
- **Adding a component means one line in `src/indexes.ts`**, and forgetting it fails a test rather
  than shipping an unindexed collection.
- **Any existing database is orphaned.** There is no rename migration and none was written, because
  nothing is deployed. Had this been decided after the first import it would have required a
  migration, and would probably not have been worth doing.
- **ADR-012's naming clause no longer holds.** Its "keep the Prisma `@@map` names" reasoning is
  superseded here; its persistence substance (native driver, portable subset, app-owned string ids,
  no transactions) is untouched.

## Related

- [ADR-002](ADR-002-package-by-component.md) — the ownership this restores
- [ADR-005](ADR-005-boundary-enforcement.md) — #4, the leaf rule `shared/persistence` was violating
- [ADR-011](ADR-011-bounded-contexts.md) — the contexts the prefixes name
- [ADR-012](ADR-012-persistence-mongodb-native-driver.md) — amended: naming clause superseded, substance intact
- `src/indexes.ts` · `src/indexes.test.ts` · each component's `infrastructure/collections.ts`
