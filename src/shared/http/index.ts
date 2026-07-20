// Facade for the http module (ADR-002/005): import only from here.
export type { AppEnv } from './app-env.js';
export { apiKeyAuth } from './auth.js';
export { requestId } from './request-id.js';
export { onError } from './on-error.js';
export {
  AppError,
  BadRequestError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
} from './errors.js';
