import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 'token',
  POSTMARK_WEBHOOK_SECRET: 'secret',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses valid env and defaults the port + token TTLs', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.jwt.secret).toBe('a-sufficiently-long-jwt-signing-secret-value');
    expect(c.jwt.accessTtlSeconds).toBe(900);
    expect(c.jwt.refreshTtlSeconds).toBe(2_592_000);
    expect(c.postmark.serverToken).toBe('token');
  });

  it('coerces PORT and the TTL overrides', () => {
    const c = loadConfig({
      ...base,
      PORT: '4000',
      JWT_ACCESS_TTL_SECONDS: '60',
      JWT_REFRESH_TTL_SECONDS: '3600',
    } as NodeJS.ProcessEnv);
    expect(c.port).toBe(4000);
    expect(c.jwt.accessTtlSeconds).toBe(60);
    expect(c.jwt.refreshTtlSeconds).toBe(3600);
  });

  it('throws on missing required config', () => {
    expect(() => loadConfig({ JWT_SECRET: base.JWT_SECRET } as NodeJS.ProcessEnv)).toThrow(
      /Invalid configuration/,
    );
  });

  it('rejects a too-short JWT secret', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'too-short' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid configuration/,
    );
  });

  it('defaults the email provider + system-email name and one-time TTLs', () => {
    const c = loadConfig(base);
    expect(c.email.provider).toBe('postmark');
    expect(c.systemEmail.fromAddress).toBe('system@cablegram.example');
    expect(c.systemEmail.fromName).toBe('cablegram');
    expect(c.oneTimeTokens.passwordResetTtlSeconds).toBe(3_600);
    expect(c.oneTimeTokens.magicLinkTtlSeconds).toBe(900);
    expect(c.accountLinks.enabled).toBe(false);
  });

  it('requires a system-email from-address', () => {
    const withoutFrom = { ...(base as Record<string, string>) };
    delete withoutFrom.SYSTEM_EMAIL_FROM_ADDRESS;
    expect(() => loadConfig(withoutFrom as NodeJS.ProcessEnv)).toThrow(/Invalid configuration/);
  });

  it('falls back the transactional token to the broadcast token when unset', () => {
    const c = loadConfig(base);
    expect(c.postmark.transactionalServerToken).toBe('token');

    const distinct = loadConfig({
      ...base,
      POSTMARK_TRANSACTIONAL_SERVER_TOKEN: 'txn-token',
    } as NodeJS.ProcessEnv);
    expect(distinct.postmark.transactionalServerToken).toBe('txn-token');
    expect(distinct.postmark.serverToken).toBe('token');
  });

  it('treats EMAIL_LINK_ENABLED as false unless the literal string "true"', () => {
    expect(loadConfig({ ...base, EMAIL_LINK_ENABLED: 'false' } as NodeJS.ProcessEnv).accountLinks.enabled).toBe(false);
    expect(loadConfig({ ...base, EMAIL_LINK_ENABLED: '0' } as NodeJS.ProcessEnv).accountLinks.enabled).toBe(false);
  });

  it('requires both link bases when EMAIL_LINK_ENABLED is true', () => {
    expect(() =>
      loadConfig({ ...base, EMAIL_LINK_ENABLED: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(/PASSWORD_RESET_URL_BASE.*required|MAGIC_LINK_URL_BASE.*required/);

    const c = loadConfig({
      ...base,
      EMAIL_LINK_ENABLED: 'true',
      PASSWORD_RESET_URL_BASE: 'https://app.example/reset',
      MAGIC_LINK_URL_BASE: 'https://app.example/magic',
    } as NodeJS.ProcessEnv);
    expect(c.accountLinks).toEqual({
      enabled: true,
      passwordResetUrlBase: 'https://app.example/reset',
      magicLinkUrlBase: 'https://app.example/magic',
    });
  });

  it('defaults BASE_URL to null and the unsubscribe secret to the JWT secret (ADR-015)', () => {
    const c = loadConfig(base);
    expect(c.baseUrl).toBeNull();
    expect(c.unsubscribe.tokenSecret).toBe(base.JWT_SECRET);
    expect(c.unsubscribe.redirectEnabled).toBe(false);
    expect(c.unsubscribe.redirectUrl).toBeNull();
  });

  it('normalizes BASE_URL by trimming a trailing slash', () => {
    expect(loadConfig({ ...base, BASE_URL: 'https://api.example.com/' } as NodeJS.ProcessEnv).baseUrl).toBe(
      'https://api.example.com',
    );
  });

  it('uses a dedicated UNSUBSCRIBE_TOKEN_SECRET when set', () => {
    const c = loadConfig({ ...base, UNSUBSCRIBE_TOKEN_SECRET: 'a-separate-unsub-secret' } as NodeJS.ProcessEnv);
    expect(c.unsubscribe.tokenSecret).toBe('a-separate-unsub-secret');
  });

  it('requires UNSUBSCRIBE_REDIRECT_URL when UNSUBSCRIBE_REDIRECT_ENABLED is true', () => {
    expect(() =>
      loadConfig({ ...base, UNSUBSCRIBE_REDIRECT_ENABLED: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(/UNSUBSCRIBE_REDIRECT_URL.*required/);

    const c = loadConfig({
      ...base,
      UNSUBSCRIBE_REDIRECT_ENABLED: 'true',
      UNSUBSCRIBE_REDIRECT_URL: 'https://example.com/goodbye',
    } as NodeJS.ProcessEnv);
    expect(c.unsubscribe.redirectEnabled).toBe(true);
    expect(c.unsubscribe.redirectUrl).toBe('https://example.com/goodbye');
  });
});
