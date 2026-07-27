import type { Db } from 'mongodb';
import type { CollectionIndexes } from './index-spec.js';

/**
 * Creates the indexes the repositories rely on (ADR-012, ADR-017). With the
 * native driver there is no `prisma db push` to materialize indexes from a
 * schema, so the app owns their creation and runs this at startup (both
 * entrypoints connect once at module scope, ADR-009) and in the
 * integration-test setup.
 *
 * **This function knows no collection names.** It takes the specs its caller
 * assembled from each owning component (ADR-017) — previously they were
 * hard-coded here, which put the schema knowledge of six domain components
 * inside a `shared/*` leaf and contradicted the ownership those components
 * otherwise have over their storage.
 *
 * `createIndexes` is idempotent — an index that already exists with the same
 * spec is a no-op — so this is safe on every warm boot. A spec with no indexes
 * is skipped rather than sent as an empty request (`createIndexes` rejects an
 * empty list), which lets a component declare a collection for the registry's
 * sake even when `_id` alone suffices.
 */
export async function ensureIndexes(
  db: Db,
  specs: readonly CollectionIndexes[],
): Promise<void> {
  for (const spec of specs) {
    if (spec.indexes.length === 0) continue;
    await db.collection(spec.collection).createIndexes([...spec.indexes]);
  }
}
