import type { IndexDescription } from 'mongodb';

/**
 * One collection's index requirements, declared by the component that **owns**
 * that collection (ADR-017).
 *
 * This type is the whole reason `shared/persistence` can stay a true leaf: it
 * describes the *shape* of an index declaration without knowing a single
 * collection name. Every name and every key lives in the owning component's
 * `infrastructure/`, and the app assembly concatenates them — the same way
 * `app.ts` mounts each component's router rather than a shared file listing
 * every route.
 */
export interface CollectionIndexes {
  /** The collection these indexes belong to (`<component>_<aggregate>`). */
  readonly collection: string;
  readonly indexes: readonly IndexDescription[];
}
