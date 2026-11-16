import { inject, injectable } from 'inversify';
import { TYPES } from '../di/index.js';
import type { AppConfig } from '../config/index.js';
import { logLine } from '../http/index.js';
import type { BulkMessage, DeliveryGateway, SendAcknowledgment } from './delivery-gateway.js';
import { EmailDeliveryError, EmailRejectedError } from './errors.js';

/** Postmark REST base. Pinned; no SDK, raw `fetch` keeps the bundle thin. */
const POSTMARK_API_BASE = 'https://api.postmarkapp.com';

/**
 * The `POST /email/bulk` request: content defined ONCE at the top level, with a
 * `Messages` array carrying the per-recipient `To`. No 500-cap (that is the
 * transactional `/email/batch` endpoint) — only a 50 MB payload ceiling.
 */
interface PostmarkBulkRequest {
  From: string;
  ReplyTo?: string;
  Subject: string;
  HtmlBody: string;
  TextBody?: string;
  MessageStream: string;
  Tag?: string;
  Messages: PostmarkBulkRecipient[];
}

/** A Postmark custom header (`{ Name, Value }`). Message-level headers win. */
interface PostmarkHeader {
  Name: string;
  Value: string;
}

/** One per-recipient entry of the bulk `Messages` array. */
interface PostmarkBulkRecipient {
  To: string;
  /**
   * Per-recipient custom headers. In the Bulk API, message-level headers take
   * precedence over request-level ones — this is how each subscriber gets their
   * own `List-Unsubscribe` value (ADR-015).
   */
  Headers?: PostmarkHeader[];
}

/**
 * The bulk submission acknowledgment Postmark returns (HTTP 200, async).
 * Pinned against the live Bulk API docs: the request id is **`Id`**, not `ID`.
 * It was once read as `ID`, which is never present, so every accepted send was
 * reported as a failure after Postmark had already started delivering it.
 */
interface PostmarkBulkResponse {
  Id?: string;
  Status?: string;
  SubmittedAt?: string;
}

/** `"Display Name <addr@example.com>"` when a name is present, else the bare address. */
function formatFrom(fromName: string, fromEmail: string): string {
  const name = fromName.trim();
  return name.length > 0 ? `${name} <${fromEmail}>` : fromEmail;
}

/**
 * The production `DeliveryGateway` (ADR-008): submits a broadcast to Postmark's
 * asynchronous Bulk API (`POST /email/bulk`) in one call over raw `fetch`,
 * reading the server token from `shared/config`. It performs no suppression or
 * rendering — both are the caller's job upstream. Per-recipient outcomes arrive
 * later via webhooks (`parseProviderEvent`), not from this call.
 */
@injectable()
export class PostmarkDeliveryGateway implements DeliveryGateway {
  constructor(@inject(TYPES.Config) private readonly config: AppConfig) {}

  async send(message: BulkMessage): Promise<SendAcknowledgment> {
    const recipientCount = message.recipients.length;
    if (recipientCount === 0) {
      // Nothing to submit; callers (campaigns) already short-circuit this.
      return {
        bulkRequestId: '',
        status: 'accepted',
        submittedAt: new Date().toISOString(),
        recipientCount: 0,
      };
    }

    let response: Response;
    try {
      response = await fetch(`${POSTMARK_API_BASE}/email/bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // A token *is* a server in Postmark: broadcast mail signs with the
          // broadcast token, transactional mail with the transactional token
          // (which falls back to the broadcast token when not separately set).
          'X-Postmark-Server-Token':
            message.category === 'broadcast'
              ? this.config.postmark.serverToken
              : this.config.postmark.transactionalServerToken,
        },
        body: JSON.stringify(this.toRequest(message)),
      });
    } catch (cause) {
      // No answer at all (refused, reset, timed out). The request may still
      // have arrived, so this is the unknown case — never a rejection.
      throw new EmailDeliveryError(
        `Postmark bulk send got no answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        undefined,
        { cause },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const failure = `Postmark bulk send failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`;
      // A 4xx is Postmark refusing the request, and it refuses a bulk request
      // whole: "the entire request is rejected with a 422, and no messages in
      // it are processed". A 5xx is not a refusal — Postmark's own wording for
      // a 500 is that "in most cases the message is lost", which is not a
      // promise — so it stays unknown (ADR-035).
      if (response.status >= 400 && response.status < 500) {
        throw new EmailRejectedError(failure, response.status);
      }
      throw new EmailDeliveryError(failure, response.status);
    }

    const body = (await response.json()) as PostmarkBulkResponse;
    if (body.Status !== 'Accepted') {
      throw new EmailDeliveryError(
        `Postmark bulk send was not accepted (status: ${body.Status ?? 'unknown'})`,
        response.status,
      );
    }
    // Accepted means Postmark has the broadcast and will deliver it, so a
    // missing id must say exactly that — not "not accepted".
    if (!body.Id) {
      throw new EmailDeliveryError(
        'Postmark accepted the bulk send but returned no request id (Id)',
        response.status,
      );
    }

    // Written before the caller stores anything: if its next write fails, this
    // line is the only record that Postmark took the submission (ADR-035).
    logLine({
      level: 'info',
      event: 'bulk_submitted',
      bulkRequestId: body.Id,
      tag: message.tag ?? null,
      sendingChannel: message.sendingChannel,
      recipientCount,
    });

    return {
      bulkRequestId: body.Id,
      status: 'accepted',
      submittedAt: body.SubmittedAt ?? new Date().toISOString(),
      recipientCount,
    };
  }

  private toRequest(message: BulkMessage): PostmarkBulkRequest {
    const request: PostmarkBulkRequest = {
      From: formatFrom(message.from.fromName, message.from.fromEmail),
      Subject: message.content.subject,
      HtmlBody: message.content.htmlBody,
      // Stream IDs are chosen by the operator in Postmark, so none is assumed
      // here (ADR-030/031): every message names its own channel, verbatim.
      MessageStream: message.sendingChannel,
      Messages: message.recipients.map((r) => {
        const entry: PostmarkBulkRecipient = { To: r.email };
        if (r.headers && r.headers.length > 0) {
          entry.Headers = r.headers.map((h) => ({ Name: h.name, Value: h.value }));
        }
        return entry;
      }),
    };
    const replyTo = message.from.replyTo;
    if (replyTo != null && replyTo.length > 0) request.ReplyTo = replyTo;
    const textBody = message.content.textBody;
    if (textBody != null && textBody.length > 0) request.TextBody = textBody;
    if (message.tag != null && message.tag.length > 0) request.Tag = message.tag;
    return request;
  }
}
