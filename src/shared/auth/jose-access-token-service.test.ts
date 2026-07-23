import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { DefaultClock, type Clock } from '../clock/index.js';
import { TEST_ENV } from '../testing/index.js';
import { JoseAccessTokenService } from './index.js';

class StubClock implements Clock {
  constructor(private readonly fixed: Date) {}
  now(): Date {
    return this.fixed;
  }
}

const config = loadConfig(TEST_ENV);

describe('JoseAccessTokenService', () => {
  it('round-trips the sub + role claims for a freshly issued token', async () => {
    const svc = new JoseAccessTokenService(config, new DefaultClock());
    const token = await svc.issueAccessToken({ userId: 'u1', role: 'admin' });
    expect(await svc.verifyAccessToken(token)).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('rejects an expired token', async () => {
    // Issued far in the past, so its exp is long gone against the real clock.
    const past = new JoseAccessTokenService(config, new StubClock(new Date('2000-01-01T00:00:00Z')));
    const token = await past.issueAccessToken({ userId: 'u1', role: 'admin' });
    const verifier = new JoseAccessTokenService(config, new DefaultClock());
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const otherConfig = loadConfig({
      ...TEST_ENV,
      JWT_SECRET: 'a-totally-different-secret-of-length-32+',
    } as NodeJS.ProcessEnv);
    const foreign = new JoseAccessTokenService(otherConfig, new DefaultClock());
    const token = await foreign.issueAccessToken({ userId: 'u1', role: 'admin' });
    const verifier = new JoseAccessTokenService(config, new DefaultClock());
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a malformed token', async () => {
    const svc = new JoseAccessTokenService(config, new DefaultClock());
    await expect(svc.verifyAccessToken('not.a.jwt')).rejects.toThrow();
  });
});
