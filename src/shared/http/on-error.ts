import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from './app-env.js';
import { AppError } from './errors.js';
import { logLine } from './request-id.js';

/**
 * Maps thrown errors to a stable JSON error shape. Presentation-only: this is
 * where domain/validation errors become HTTP responses (ADR-004).
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');

  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details, requestId } },
      err.status,
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      { error: { code: 'validation_error', message: 'Invalid request', details: err.issues, requestId } },
      400,
    );
  }

  logLine({
    level: 'error',
    event: 'unhandled_error',
    requestId,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json(
    { error: { code: 'internal_error', message: 'Internal server error', requestId } },
    500,
  );
};
