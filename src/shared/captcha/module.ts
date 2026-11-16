import { ContainerModule } from 'inversify';
import { CAPTCHA_TYPES } from './types.js';
import type { CaptchaVerifier } from './captcha-verifier.js';
import { TurnstileCaptchaVerifier } from './turnstile-captcha-verifier.js';

/**
 * The captcha module's DI wiring (ADR-034), loaded by the composition root.
 * Turnstile is the production binding; tests rebind to `FakeCaptchaVerifier`.
 */
export const captchaModule = new ContainerModule((bind) => {
  bind<CaptchaVerifier>(CAPTCHA_TYPES.CaptchaVerifier).to(TurnstileCaptchaVerifier);
});
