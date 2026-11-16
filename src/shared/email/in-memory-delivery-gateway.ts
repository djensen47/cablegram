import { injectable } from 'inversify';
import type { BulkMessage, DeliveryGateway, SendAcknowledgment } from './delivery-gateway.js';
import { EmailDeliveryError, EmailRejectedError } from './errors.js';

/**
 * A real in-memory `DeliveryGateway` (not a mock) — the DI-rebind test seam
 * (ADR-003). It records every submission it accepts so tests can assert what a
 * use case handed the provider, and returns a deterministic acceptance
 * acknowledgment mirroring the Postmark gateway's happy path.
 *
 * It can also be told to end its next call the two ways a real provider call
 * fails (ADR-035), because what a caller does next is different for each:
 * {@link refuseNext} — the provider said no and holds nothing — and
 * {@link loseNextAnswer} — the provider took the submission and the caller
 * never heard back.
 */
@injectable()
export class InMemoryDeliveryGateway implements DeliveryGateway {
  /** Every submission the provider **accepted**, in call order. */
  readonly sent: BulkMessage[] = [];
  /** Every call made, accepted or not. */
  calls = 0;
  private readonly script: Array<'refuse' | 'lose-answer'> = [];

  /** The next `send` is refused: nothing is accepted (`EmailRejectedError`). */
  refuseNext(): void {
    this.script.push('refuse');
  }

  /** The next `send` is accepted, and its answer never arrives (`EmailDeliveryError`). */
  loseNextAnswer(): void {
    this.script.push('lose-answer');
  }

  async send(message: BulkMessage): Promise<SendAcknowledgment> {
    this.calls += 1;
    const ending = this.script.shift();
    if (ending === 'refuse') {
      throw new EmailRejectedError('Provider refused the submission (HTTP 422): no such stream', 422);
    }

    this.sent.push(message);
    if (ending === 'lose-answer') {
      throw new EmailDeliveryError('Provider gave no answer: socket hang up');
    }
    return {
      bulkRequestId: `in-memory-${this.sent.length}`,
      status: 'accepted',
      submittedAt: '1970-01-01T00:00:00.000Z',
      recipientCount: message.recipients.length,
    };
  }
}
