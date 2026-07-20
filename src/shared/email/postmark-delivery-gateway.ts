import { inject, injectable } from 'inversify';
import { TYPES } from '../di/index.js';
import type { AppConfig } from '../config/index.js';
import type {
  BulkMessage,
  DeliveryGateway,
  DeliveryResult,
  EmailRecipient,
} from './delivery-gateway.js';
import { EmailDeliveryError } from './errors.js';

/** Postmark REST base. Pinned; no SDK, raw `fetch` keeps the bundle thin. */
const POSTMARK_API_BASE = 'https://api.postmarkapp.com';

/**
 * Postmark's batch endpoint accepts at most 500 messages per call (live docs,
 * `POST /email/batch`, also capped at 50 MB/call). Recipient sets larger than
 * this are split across calls internally — the caller sees one `send`.
 */
const BATCH_LIMIT = 500;

/** Newsletters are broadcasts; Postmark routes those on the broadcast stream. */
const DEFAULT_MESSAGE_STREAM = 'broadcast';

/** One entry of the `POST /email/batch` request array (subset we populate). */
interface PostmarkBatchMessage {
  From: string;
  To: string;
  ReplyTo?: string;
  Subject: string;
  HtmlBody: string;
  TextBody?: string;
  MessageStream: string;
  Tag?: string;
}

/** One entry of the batch response array (Postmark returns HTTP 200 per batch). */
interface PostmarkBatchResult {
  ErrorCode: number;
  Message: string;
  MessageID?: string;
  To?: string;
}

/** `"Display Name <addr@example.com>"` when a name is present, else the bare address. */
function formatFrom(fromName: string, fromEmail: string): string {
  const name = fromName.trim();
  return name.length > 0 ? `${name} <${fromEmail}>` : fromEmail;
}

/** Split into contiguous chunks of at most `size` (for the per-call batch cap). */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * The production `DeliveryGateway` (ADR-008): maps a recipient set to one (or,
 * past the 500-cap, several) Postmark batch calls over raw `fetch`, reading the
 * server token from `shared/config`. It performs no suppression or rendering —
 * both are the caller's job upstream.
 */
@injectable()
export class PostmarkDeliveryGateway implements DeliveryGateway {
  constructor(@inject(TYPES.Config) private readonly config: AppConfig) {}

  async send(message: BulkMessage): Promise<DeliveryResult[]> {
    if (message.recipients.length === 0) return [];

    const stream = message.messageStream ?? DEFAULT_MESSAGE_STREAM;
    const payloads = message.recipients.map((r) => this.toPayload(message, r, stream));

    const results: DeliveryResult[] = [];
    for (const batch of chunk(payloads, BATCH_LIMIT)) {
      results.push(...(await this.postBatch(batch)));
    }
    return results;
  }

  private toPayload(
    message: BulkMessage,
    recipient: EmailRecipient,
    stream: string,
  ): PostmarkBatchMessage {
    const payload: PostmarkBatchMessage = {
      From: formatFrom(message.from.fromName, message.from.fromEmail),
      To: recipient.email,
      Subject: message.content.subject,
      HtmlBody: message.content.htmlBody,
      MessageStream: stream,
    };
    const replyTo = message.from.replyTo;
    if (replyTo != null && replyTo.length > 0) payload.ReplyTo = replyTo;
    const textBody = message.content.textBody;
    if (textBody != null && textBody.length > 0) payload.TextBody = textBody;
    if (message.tag != null && message.tag.length > 0) payload.Tag = message.tag;
    return payload;
  }

  private async postBatch(batch: PostmarkBatchMessage[]): Promise<DeliveryResult[]> {
    const response = await fetch(`${POSTMARK_API_BASE}/email/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': this.config.postmark.serverToken,
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new EmailDeliveryError(
        `Postmark batch send failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    const body = (await response.json()) as PostmarkBatchResult[];
    return body.map((r, i) => ({
      email: r.To ?? batch[i]?.To ?? '',
      messageId: r.MessageID ?? null,
      accepted: r.ErrorCode === 0,
      errorCode: r.ErrorCode,
      message: r.Message,
    }));
  }
}
