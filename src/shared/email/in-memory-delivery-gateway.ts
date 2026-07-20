import { injectable } from 'inversify';
import type { BulkMessage, DeliveryGateway, SendAcknowledgment } from './delivery-gateway.js';

/**
 * A real in-memory `DeliveryGateway` (not a mock) — the DI-rebind test seam
 * (ADR-003). It records every `send` so tests can assert what a use case handed
 * the provider, and returns a deterministic acceptance acknowledgment mirroring
 * the Postmark gateway's happy path.
 */
@injectable()
export class InMemoryDeliveryGateway implements DeliveryGateway {
  /** Every message passed to `send`, in call order. */
  readonly sent: BulkMessage[] = [];

  async send(message: BulkMessage): Promise<SendAcknowledgment> {
    this.sent.push(message);
    return {
      bulkRequestId: `in-memory-${this.sent.length}`,
      status: 'accepted',
      submittedAt: '1970-01-01T00:00:00.000Z',
      recipientCount: message.recipients.length,
    };
  }
}
