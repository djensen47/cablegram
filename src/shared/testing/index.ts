// Facade for the testing module (ADR-002/005): import only from here.
// Test-only infrastructure; never imported by production code.
export { startMongoMemoryServer } from './mongo-memory.js';
export { TEST_ENV, TEST_JWT_SECRET, bearerToken, bearerHeaders } from './http-auth.js';
