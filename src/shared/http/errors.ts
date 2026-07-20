import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * HTTP-flavored error used by the presentation layer. Domain errors are mapped
 * onto these at the edge; use cases never throw HTTP concerns (ADR-001).
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode = 500,
    readonly code: string = 'internal_error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, 400, 'bad_request', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'unauthorized');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, 409, 'conflict', details);
  }
}
