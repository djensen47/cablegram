// Facade for the di module (ADR-002/005): import only from here.
//
// `TYPES` is re-exported BEFORE `buildContainer` on purpose. The composition
// root (container.js) statically imports every component's module, whose use
// cases read these tokens in `@inject(...)` decorators at class-definition
// time — an import cycle (di → component → di). Evaluating types.js first
// (ESM evaluates re-exports in source order) guarantees the tokens exist before
// that cycle is entered. Do not reorder.
export { TYPES } from './types.js';
export { buildContainer } from './container.js';
