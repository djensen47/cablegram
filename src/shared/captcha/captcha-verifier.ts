/**
 * Proof that a human submitted a public form (ADR-034). A shared technical leaf,
 * like `email`: it knows nothing of newsletters or subscriptions, only how to
 * ask the provider whether a token the visitor's browser obtained is genuine.
 */
export interface CaptchaVerifier {
  /**
   * Whether a provider secret is configured. Without one, nothing can be
   * verified, so public signup is unavailable rather than unprotected.
   */
  readonly configured: boolean;
  /**
   * `true` when the provider accepts `token`; `false` when it rejects it
   * (forged, expired, already used). Throws `CaptchaUnavailableError` when the
   * provider cannot be asked at all, so an outage is not mistaken for a bot.
   */
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

/** The provider could not be reached, or answered with something unusable. */
export class CaptchaUnavailableError extends Error {
  constructor(reason: string) {
    super(`Captcha verification unavailable: ${reason}`);
    this.name = 'CaptchaUnavailableError';
  }
}
