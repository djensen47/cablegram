// Facade for the captcha module (ADR-002/005, ADR-034): import only from here.
// A shared technical leaf — it imports no domain component.

// Token first, for the same import-cycle reason as `shared/email`'s facade.
export { CAPTCHA_TYPES } from './types.js';
export { captchaModule } from './module.js';

export type { CaptchaVerifier } from './captcha-verifier.js';
export { CaptchaUnavailableError } from './captcha-verifier.js';
export {
  TurnstileCaptchaVerifier,
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_MAX_TOKEN_LENGTH,
} from './turnstile-captcha-verifier.js';
export { FakeCaptchaVerifier } from './fake-captcha-verifier.js';
