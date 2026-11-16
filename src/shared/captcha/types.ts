/**
 * DI tokens for the captcha module (ADR-003, ADR-034). Consumers (the
 * `subscriptions` public signup) inject the `CaptchaVerifier` interface via
 * this token; tests rebind it to `FakeCaptchaVerifier`.
 */
export const CAPTCHA_TYPES = {
  CaptchaVerifier: Symbol.for('CaptchaVerifier'),
} as const;
