// Facade for the persistence module (ADR-002/005): import only from here.
// A true `shared/*` leaf — it imports no domain component; it owns only the
// cross-cutting MongoDB bootstrap (collection names + index creation, ADR-012).
export { COLLECTIONS } from './collections.js';
export { ensureIndexes } from './ensure-indexes.js';
