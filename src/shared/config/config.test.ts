import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 'token',
  POSTMARK_WEBHOOK_SECRET: 'secret',
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
});
