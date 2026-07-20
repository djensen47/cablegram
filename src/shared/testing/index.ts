// Facade for the testing module (ADR-002/005): import only from here.
// Integration-test-only infrastructure; never imported by production code.
export { startMongoMemoryReplicaSet, pushPrismaSchema } from './mongo-memory.js';
