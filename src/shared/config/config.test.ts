import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'a, b',
  POSTMARK_SERVER_TOKEN: 'token',
  POSTMARK_WEBHOOK_SECRET: 'secret',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses valid env and defaults the port', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.apiKeys).toEqual(['a', 'b']);
    expect(c.postmark.serverToken).toBe('token');
  });

  it('coerces PORT', () => {
    expect(loadConfig({ ...base, PORT: '4000' } as NodeJS.ProcessEnv).port).toBe(4000);
  });

  it('throws on missing required config', () => {
    expect(() => loadConfig({ API_KEYS: 'a' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid configuration/,
    );
  });
});
