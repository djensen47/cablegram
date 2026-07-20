// Facade for the http module (ADR-002/005): import only from here.
export type { AppEnv } from './app-env.js';
export { apiKeyAuth } from './auth.js';
export { requestId, requestLogging, logLine } from './request-id.js';
export { onError } from './on-error.js';
export { idempotencyKey } from './idempotency.js';
export {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type IdempotencyRecord,
} from './idempotency-store.js';
export {
  AppError,
  BadRequestError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
} from './errors.js';
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  toPage,
  type PaginationQuery,
  type Page,
} from './pagination.js';
