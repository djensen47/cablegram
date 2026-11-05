import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ENV } from '../testing/index.js';
import { buildContainer } from './container.js';

/** The structured lines `logLine` wrote to stdout, parsed. */
function loggedLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

describe('buildContainer — deprecated env vars (ADR-031)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs one warning when only the old POSTMARK_TRANSACTIONAL_STREAM is set', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    buildContainer({
      ...TEST_ENV,
      SYSTEM_EMAIL_CHANNEL: undefined,
      POSTMARK_TRANSACTIONAL_STREAM: 'outbound',
    } as NodeJS.ProcessEnv);

    const warnings = loggedLines(spy).filter((l) => l.event === 'deprecated_config');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      variable: 'POSTMARK_TRANSACTIONAL_STREAM',
    });
    expect(String(warnings[0]!.message)).toContain('use SYSTEM_EMAIL_CHANNEL');
  });

  it('logs nothing when only the new SYSTEM_EMAIL_CHANNEL is set', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    buildContainer(TEST_ENV);

    expect(loggedLines(spy).filter((l) => l.event === 'deprecated_config')).toEqual([]);
  });
});
