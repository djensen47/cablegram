import type { CaptchaVerifier } from './captcha-verifier.js';

/**
 * Test double for `CaptchaVerifier` (ADR-003 rebind). Accepts exactly one
 * token, `FakeCaptchaVerifier.PASS`, and records every call so a test can
 * assert what the use case forwarded (the token, the visitor's IP).
 */
export class FakeCaptchaVerifier implements CaptchaVerifier {
  static readonly PASS = 'captcha-pass';
  readonly calls: { token: string; remoteIp?: string }[] = [];

  constructor(readonly configured: boolean = true) {}

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    this.calls.push({ token, remoteIp });
    return token === FakeCaptchaVerifier.PASS;
  }
}
