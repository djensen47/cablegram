import { inject, injectable } from 'inversify';
import { TYPES } from '../di/index.js';
import type { AppConfig } from '../config/index.js';
import { CaptchaUnavailableError, type CaptchaVerifier } from './captcha-verifier.js';

/** Cloudflare's server-side validation endpoint (pinned against its docs). */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Turnstile tokens are at most 2048 characters; anything longer is not one. */
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048;

interface SiteverifyResponse {
  success?: unknown;
  'error-codes'?: unknown;
}

/**
 * The production `CaptchaVerifier`: Cloudflare Turnstile (ADR-034). Posts the
 * visitor's token, the secret and (when known) the visitor's IP to
 * `siteverify` as a form body, over raw `fetch` — no SDK, as with Postmark.
 *
 * Tokens are single-use and valid for five minutes; Turnstile enforces both, so
 * a replayed or stale token simply comes back `success: false`.
 */
@injectable()
export class TurnstileCaptchaVerifier implements CaptchaVerifier {
  constructor(@inject(TYPES.Config) private readonly config: AppConfig) {}

  get configured(): boolean {
    return this.config.publicSignup.turnstileSecretKey !== null;
  }

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    const secret = this.config.publicSignup.turnstileSecretKey;
    if (secret === null) throw new CaptchaUnavailableError('TURNSTILE_SECRET_KEY is not set');
    if (token.length === 0 || token.length > TURNSTILE_MAX_TOKEN_LENGTH) return false;

    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp !== undefined) body.set('remoteip', remoteIp);

    let response: Response;
    try {
      response = await fetch(TURNSTILE_SITEVERIFY_URL, { method: 'POST', body });
    } catch (err) {
      throw new CaptchaUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) throw new CaptchaUnavailableError(`siteverify answered HTTP ${response.status}`);

    const result = (await response.json().catch(() => ({}))) as SiteverifyResponse;
    // A misconfigured secret is our fault, not the visitor's: surface it as
    // "unavailable" so the operator sees it, instead of rejecting every human.
    const codes = Array.isArray(result['error-codes']) ? (result['error-codes'] as unknown[]) : [];
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      throw new CaptchaUnavailableError('Turnstile rejected the secret key');
    }
    return result.success === true;
  }
}
