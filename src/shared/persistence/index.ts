// Facade for the persistence module (ADR-002/005): import only from here.
// A true `shared/*` leaf — and now genuinely one: it owns the index-creation
// *mechanism* and knows no collection name (ADR-017). Names and index keys live
// in the component that owns each collection.
export type { CollectionIndexes } from './index-spec.js';
export { ensureIndexes } from './ensure-indexes.js';
