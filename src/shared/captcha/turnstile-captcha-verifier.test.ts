import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CaptchaUnavailableError,
  TURNSTILE_SITEVERIFY_URL,
  TurnstileCaptchaVerifier,
} from './index.js';

function verifierWith(turnstileSecretKey: string | null) {
  return new TurnstileCaptchaVerifier({
    publicSignup: { turnstileSecretKey, corsAllowedOrigins: [] },
  } as never);
}

/** Stub `fetch` with one siteverify answer, capturing what was sent. */
function stubSiteverify(answer: unknown, status = 200) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: init?.body as URLSearchParams });
    return new Response(JSON.stringify(answer), { status });
  });
  return calls;
}

describe('TurnstileCaptchaVerifier (ADR-034)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is not configured without a secret, and refuses to verify', async () => {
    const verifier = verifierWith(null);
    expect(verifier.configured).toBe(false);
    await expect(verifier.verify('token')).rejects.toBeInstanceOf(CaptchaUnavailableError);
  });

  it('posts secret, token and visitor IP to siteverify as a form body', async () => {
    const calls = stubSiteverify({ success: true });

    expect(await verifierWith('sekret').verify('tok-123', '203.0.113.7')).toBe(true);

    expect(calls[0]!.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      secret: 'sekret',
      response: 'tok-123',
      remoteip: '203.0.113.7',
    });
  });

  it('omits remoteip when the visitor IP is unknown', async () => {
    const calls = stubSiteverify({ success: true });
    await verifierWith('sekret').verify('tok-123');
    expect(calls[0]!.body.has('remoteip')).toBe(false);
  });

  it('returns false for a token Turnstile rejects (forged, expired, reused)', async () => {
    stubSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await verifierWith('sekret').verify('stale')).toBe(false);
  });

  it('treats a rejected secret as unavailable, not as a bot', async () => {
    stubSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    await expect(verifierWith('wrong').verify('tok')).rejects.toBeInstanceOf(CaptchaUnavailableError);
  });

  it('treats a network failure or a non-200 answer as unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(verifierWith('sekret').verify('tok')).rejects.toBeInstanceOf(CaptchaUnavailableError);

    stubSiteverify({}, 500);
    await expect(verifierWith('sekret').verify('tok')).rejects.toBeInstanceOf(CaptchaUnavailableError);
  });

  it('rejects an empty or over-long token without calling Turnstile', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const verifier = verifierWith('sekret');
    expect(await verifier.verify('')).toBe(false);
    expect(await verifier.verify('x'.repeat(2049))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
