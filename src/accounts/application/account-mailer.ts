import { inject, injectable } from 'inversify';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import type { AppConfig } from '../../shared/config/index.js';
import { EMAIL_TYPES, type DeliveryGateway, type SenderIdentity } from '../../shared/email/index.js';

/**
 * Sends cablegram's own **transactional** account mail (ADR-013/014):
 * password-reset and magic-link messages. Unlike subscribe confirmations these
 * have no newsletter to borrow a sender from, so they go out from the configured
 * system identity (`systemEmail`) on the `transactional` category — mirroring how
 * `subscribe.ts` drives the shared `DeliveryGateway`, the one email seam.
 *
 * How the one-time token is presented depends on config (`accountLinks`): with a
 * front-end configured the email carries a ready link (`<base>?token=…`); headless,
 * it carries the raw token plus the API path the consumer posts it to. The token
 * itself is opaque and shown exactly once — only its hash is stored.
 */
@injectable()
export class AccountMailer {
  constructor(
    @inject(EMAIL_TYPES.DeliveryGateway) private readonly delivery: DeliveryGateway,
    @inject(SHARED_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async sendPasswordReset(email: string, token: string): Promise<void> {
    const ref = this.reference(this.config.accountLinks.passwordResetUrlBase, '/v1/auth/password-reset/confirm', token);
    await this.delivery.send({
      from: this.systemSender(),
      content: {
        subject: 'Reset your cablegram password',
        htmlBody:
          `<p>We received a request to reset your password. ${ref.html}</p>` +
          `<p>This request expires shortly. If you did not ask for it, you can ignore this email.</p>`,
        textBody:
          `We received a request to reset your password.\n\n${ref.text}\n\n` +
          `This request expires shortly. If you did not ask for it, you can ignore this email.`,
      },
      recipients: [{ email }],
      category: 'transactional',
      tag: 'password-reset',
    });
  }

  async sendMagicLink(email: string, token: string): Promise<void> {
    const ref = this.reference(this.config.accountLinks.magicLinkUrlBase, '/v1/auth/magic-link/consume', token);
    await this.delivery.send({
      from: this.systemSender(),
      content: {
        subject: 'Your cablegram sign-in link',
        htmlBody:
          `<p>Use the link below to sign in. ${ref.html}</p>` +
          `<p>This link expires shortly and can be used once. If you did not request it, you can ignore this email.</p>`,
        textBody:
          `Use the reference below to sign in.\n\n${ref.text}\n\n` +
          `This link expires shortly and can be used once. If you did not request it, you can ignore this email.`,
      },
      recipients: [{ email }],
      category: 'transactional',
      tag: 'magic-link',
    });
  }

  private systemSender(): SenderIdentity {
    return {
      fromName: this.config.systemEmail.fromName,
      fromEmail: this.config.systemEmail.fromAddress,
    };
  }

  /**
   * Present the one-time token either as a ready link (when a front-end base URL
   * is configured) or as the raw token plus the API path to submit it to
   * (headless default). `apiPath` is the endpoint that consumes the token.
   */
  private reference(base: string | null, apiPath: string, token: string): { html: string; text: string } {
    if (this.config.accountLinks.enabled && base) {
      const link = appendToken(base, token);
      return {
        html: `Continue here: <a href="${link}">${link}</a>.`,
        text: `Continue here: ${link}`,
      };
    }
    return {
      html: `Submit this token to <code>POST ${apiPath}</code>: <code>${token}</code>`,
      text: `Submit this token to POST ${apiPath}:\n\n${token}`,
    };
  }
}

/** Append the token as a `token` query parameter, preserving any existing query. */
function appendToken(base: string, token: string): string {
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}
