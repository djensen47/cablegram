import { injectable } from 'inversify';
import type { BulkMessage, DeliveryGateway, DeliveryResult } from './delivery-gateway.js';

/**
 * A real in-memory `DeliveryGateway` (not a mock) — the DI-rebind test seam
 * (ADR-003). It records every `send` so tests can assert what a use case handed
 * the provider, and reports every recipient accepted, mirroring the happy path
 * of the Postmark gateway (one accepted result per recipient).
 */
@injectable()
export class InMemoryDeliveryGateway implements DeliveryGateway {
  /** Every message passed to `send`, in call order. */
  readonly sent: BulkMessage[] = [];

  async send(message: BulkMessage): Promise<DeliveryResult[]> {
    this.sent.push(message);
    return message.recipients.map((r, i) => ({
      email: r.email,
      messageId: `in-memory-${this.sent.length}-${i}`,
      accepted: true,
      errorCode: 0,
      message: 'OK',
    }));
  }
}
