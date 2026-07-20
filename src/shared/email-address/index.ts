// Facade for the email-address module (ADR-002/005): import only from here.
// A pure, tiny shared leaf — no framework, no IO, no domain component import.
export { normalizeEmailAddress } from './normalize.js';
