import { injectable } from 'inversify';

/** A source of the current time — injected so use cases stay testable (ADR-003). */
export interface Clock {
  now(): Date;
}

@injectable()
export class DefaultClock implements Clock {
  now(): Date {
    return new Date();
  }
}
