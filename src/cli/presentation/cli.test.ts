import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ApiClient, ApiRequest } from '../application/api-client.js';
import { ApiError } from '../application/api-error.js';
import type { CredentialStore, StoredCredentials } from '../application/credential-store.js';
import type { CliDeps } from '../application/deps.js';
import { EXIT, run } from './program.js';

/**
 * Command-level tests: the **real** commander program driven end to end with a
 * stub `ApiClient` and an in-memory credential store (ADR-016 §2).
 *
 * This is the CLI mirror of the server's route tests, which run the real Hono
 * app with repositories rebound to in-memory doubles (ADR-003). It exercises
 * argument parsing, flag validation, the request the command actually issues,
 * and the exit code — with no network and no config file on disk.
 */

const NOW = new Date('2026-07-25T12:00:00.000Z');

// A JWT-shaped token whose payload decodes to a known user (unsigned — the CLI
// never verifies, ADR-016 §1).
function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.signature`;
}

interface Recorded {
  method: string;
  path: string;
  query?: ApiRequest['query'];
  body?: unknown;
}

class StubApiClient implements ApiClient {
  readonly calls: Recorded[] = [];
  responses = new Map<string, unknown>();
  failWith: ApiError | null = null;

  constructor(private readonly base = 'https://api.example.com') {}

  private record<T>(method: string, path: string, query?: ApiRequest['query'], body?: unknown): T {
    this.calls.push({ method, path, query, body });
    if (this.failWith !== null) throw this.failWith;
    return (this.responses.get(`${method} ${path}`) ?? this.responses.get(path) ?? {}) as T;
  }

  async get<T>(path: string, query?: ApiRequest['query']): Promise<T> {
    return this.record<T>('GET', path, query);
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.record<T>('POST', path, undefined, body);
  }
  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.record<T>('PATCH', path, undefined, body);
  }
  async delete(path: string): Promise<void> {
    this.record('DELETE', path);
  }
  async listAll<T>(path: string, query?: ApiRequest['query']): Promise<T[]> {
    const envelope = this.record<{ data?: T[] }>('GET', path, query);
    return envelope.data ?? [];
  }
  baseUrl(): string {
    return this.base;
  }
}

function harness(initial: StoredCredentials | null = loggedIn()) {
  let stored = initial;
  const api = new StubApiClient();

  const store: CredentialStore = {
    load: async () => stored,
    save: async (c) => {
      stored = c;
    },
    clear: async () => {
      stored = null;
    },
    location: () => '/tmp/cablegram-test.json',
  };

  const deps: CliDeps = { store, createClient: () => api, now: () => NOW };
  return { api, deps, credentials: () => stored };
}

function loggedIn(): StoredCredentials {
  return {
    baseUrl: 'https://api.example.com',
    accessToken: fakeJwt({ sub: 'user-1', role: 'admin', exp: 4102444800 }),
    accessTokenExpiresAt: '2026-07-25T12:15:00.000Z',
    refreshToken: 'refresh-1',
  };
}

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  // The tests run without a TTY, which is exactly the non-interactive path.
  delete process.env.CABLEGRAM_TOKEN;
  delete process.env.CABLEGRAM_URL;
  delete process.env.CABLEGRAM_PASSWORD;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('newsletters', () => {
  it('lists with pagination flags and renders a table', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/newsletters', {
      data: [
        {
          id: 'n1',
          name: 'Weekly',
          fromName: 'Editors',
          fromEmail: 'hi@example.com',
          createdAt: '2026-07-01T10:00:00.000Z',
        },
      ],
      meta: { nextCursor: null },
    });

    const code = await run(deps, ['newsletters', 'list', '--limit', '50']);

    expect(code).toBe(EXIT.ok);
    expect(api.calls[0]).toMatchObject({
      method: 'GET',
      path: '/v1/newsletters',
      query: { limit: 50 },
    });
    expect(stdout).toContain('Weekly');
    expect(stdout).toContain('hi@example.com');
  });

  it('emits the raw envelope and nothing else under --json', async () => {
    const { api, deps } = harness();
    const envelope = { data: [{ id: 'n1', name: 'Weekly' }], meta: { nextCursor: 'n1' } };
    api.responses.set('/v1/newsletters', envelope);

    await run(deps, ['--json', 'newsletters', 'list']);

    // Parseable as a single document — the scriptable contract (ADR-016 §3).
    expect(JSON.parse(stdout)).toEqual(envelope);
  });

  it('rejects an out-of-range --limit at the CLI edge, before any request', async () => {
    const { api, deps } = harness();

    const code = await run(deps, ['newsletters', 'list', '--limit', '5000']);

    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('--limit');
    expect(api.calls).toHaveLength(0);
  });

  it('creates from flags without prompting', async () => {
    const { api, deps } = harness();
    api.responses.set('POST /v1/newsletters', { id: 'n2', name: 'Weekly' });

    const code = await run(deps, [
      'newsletters',
      'create',
      '--name',
      'Weekly',
      '--from-name',
      'Editors',
      '--from-email',
      'hi@example.com',
    ]);

    expect(code).toBe(EXIT.ok);
    expect(api.calls[0]?.body).toMatchObject({
      name: 'Weekly',
      fromName: 'Editors',
      fromEmail: 'hi@example.com',
    });
  });

  it('fails with a usage error, not a hang, when a required value is missing and there is no TTY', async () => {
    const { api, deps } = harness();

    const code = await run(deps, ['newsletters', 'create', '--name', 'Weekly']);

    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/--from-name/);
    expect(api.calls).toHaveLength(0);
  });

  it('sends only the named fields on update, and treats "null" as an explicit clear', async () => {
    const { api, deps } = harness();

    await run(deps, ['newsletters', 'update', 'n1', '--reply-to', 'null']);

    expect(api.calls[0]).toMatchObject({ method: 'PATCH', path: '/v1/newsletters/n1' });
    expect(api.calls[0]?.body).toEqual({ replyTo: null });
  });

  it('refuses a no-op update rather than sending an empty PATCH', async () => {
    const { api, deps } = harness();

    const code = await run(deps, ['newsletters', 'update', 'n1']);

    expect(code).toBe(EXIT.usage);
    expect(api.calls).toHaveLength(0);
  });

  it('requires confirmation to delete, and --yes supplies it', async () => {
    const { api, deps } = harness();

    const refused = await run(deps, ['newsletters', 'delete', 'n1']);
    expect(refused).toBe(EXIT.usage);
    expect(api.calls).toHaveLength(0);

    const confirmed = await run(deps, ['--yes', 'newsletters', 'delete', 'n1']);
    expect(confirmed).toBe(EXIT.ok);
    expect(api.calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/newsletters/n1' });
  });
});

describe('campaigns send', () => {
  const draft = {
    id: 'c1',
    name: 'July Update',
    newsletterId: 'n1',
    status: 'draft',
    segmentTags: [],
    stats: { recipients: 0, accepted: 0, delivered: 0, bounced: 0, complained: 0 },
    sentAt: null,
  };

  it('never sends without confirmation', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/campaigns/c1', draft);

    const code = await run(deps, ['campaigns', 'send', 'c1']);

    expect(code).toBe(EXIT.usage);
    expect(api.calls.some((c) => c.path.endsWith('/send'))).toBe(false);
  });

  it('sends with --yes and reports the outcome', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/campaigns/c1', draft);
    api.responses.set('/v1/newsletters/n1/subscriptions', { data: [{ id: 's1', tags: [] }] });
    api.responses.set('POST /v1/campaigns/c1/send', {
      ...draft,
      status: 'sent',
      stats: { ...draft.stats, recipients: 1, accepted: 1 },
    });

    const code = await run(deps, ['--yes', 'campaigns', 'send', 'c1']);

    expect(code).toBe(EXIT.ok);
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/campaigns/c1/send')).toBe(true);
    expect(stderr).toContain('1 recipient(s)');
  });

  it('counts recipients but does not send under --dry-run', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/campaigns/c1', { ...draft, segmentTags: ['vip'] });
    api.responses.set('/v1/newsletters/n1/subscriptions', {
      data: [
        { id: 's1', tags: ['vip'] },
        { id: 's2', tags: ['other'] },
      ],
    });

    const code = await run(deps, ['--json', 'campaigns', 'send', 'c1', '--dry-run']);

    expect(code).toBe(EXIT.ok);
    // Segment filtering is applied to the estimate.
    expect(JSON.parse(stdout)).toMatchObject({ estimatedRecipients: 1 });
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('is a no-op on an already-sent campaign', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/campaigns/c1', {
      ...draft,
      status: 'sent',
      sentAt: '2026-07-01T09:00:00.000Z',
    });

    const code = await run(deps, ['--yes', 'campaigns', 'send', 'c1']);

    expect(code).toBe(EXIT.ok);
    expect(stderr).toMatch(/already sent/i);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects a campaign with two content sources before calling the API', async () => {
    const { api, deps } = harness();

    const code = await run(deps, [
      'campaigns',
      'create',
      '--newsletter',
      'n1',
      '--name',
      'X',
      '--template',
      't1',
      '--subject',
      'Hi',
    ]);

    // A usage error: the invocation was wrong, so this is a 2, not a 1.
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/not both/i);
    expect(api.calls).toHaveLength(0);
  });
});

describe('auth', () => {
  it('stores the session returned by login', async () => {
    const { api, deps, credentials } = harness(null);
    api.responses.set('POST /v1/auth/login', {
      tokenType: 'Bearer',
      accessToken: fakeJwt({ sub: 'user-9', role: 'manager', exp: 4102444800 }),
      refreshToken: 'refresh-new',
      expiresIn: 900,
    });
    process.env.CABLEGRAM_PASSWORD = 'correct horse battery';

    const code = await run(deps, [
      'login',
      '--url',
      'https://api.example.com',
      '--email',
      'a@b.co',
    ]);

    expect(code).toBe(EXIT.ok);
    expect(credentials()).toMatchObject({
      baseUrl: 'https://api.example.com',
      refreshToken: 'refresh-new',
      // expiresIn resolved against the injected clock.
      accessTokenExpiresAt: '2026-07-25T12:15:00.000Z',
    });
    expect(stderr).toContain('user-9 (manager)');
  });

  it('does not claim an email was sent when requesting a magic link', async () => {
    const { deps } = harness(null);

    await run(deps, ['login', '--url', 'https://api.example.com', '--magic-link', '--email', 'a@b.co']);

    // Non-enumerating (ADR-014): the wording must stay conditional.
    expect(stderr).toMatch(/if that address has an account/i);
  });

  it('clears the local session even when the server cannot be reached', async () => {
    const { api, deps, credentials } = harness();
    api.failWith = new ApiError('down', 0, 'transport_error');

    const code = await run(deps, ['logout']);

    expect(code).toBe(EXIT.ok);
    expect(credentials()).toBeNull();
    expect(stderr).toMatch(/clearing it locally/i);
  });

  it('reports the decoded claims in whoami without a network call', async () => {
    const { api, deps } = harness();

    await run(deps, ['whoami']);

    expect(stdout).toContain('user-1');
    expect(stdout).toContain('admin');
    expect(api.calls).toHaveLength(0);
  });

  it('exits with the auth code when a URL is configured but no session exists', async () => {
    const { deps } = harness({ baseUrl: 'https://api.example.com' });

    const code = await run(deps, ['newsletters', 'list']);

    expect(code).toBe(EXIT.auth);
    expect(stderr).toMatch(/not logged in/i);
  });

  it('reports an unconfigured CLI as a usage error, not an unreachable server', async () => {
    const { deps } = harness(null);

    const code = await run(deps, ['newsletters', 'list']);

    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/no cablegram url configured/i);
  });
});

describe('error rendering', () => {
  it('maps a 404 to the failure exit code and prints the server message', async () => {
    const { api, deps } = harness();
    api.failWith = new ApiError('Newsletter not found', 404, 'not_found', undefined, 'req-7');

    const code = await run(deps, ['newsletters', 'get', 'missing']);

    expect(code).toBe(EXIT.failed);
    expect(stderr).toContain('Newsletter not found');
    expect(stderr).toContain('req-7');
  });

  it('maps a 403 to the auth exit code', async () => {
    const { api, deps } = harness();
    api.failWith = new ApiError('Requires the admin role', 403, 'forbidden');

    expect(await run(deps, ['users', 'list'])).toBe(EXIT.auth);
  });

  it('maps an unreachable deployment to its own exit code', async () => {
    const { api, deps } = harness();
    api.failWith = new ApiError('Could not reach https://api.example.com', 0, 'transport_error');

    expect(await run(deps, ['newsletters', 'list'])).toBe(EXIT.unreachable);
  });

  it('treats --help as success', async () => {
    const { deps } = harness();
    expect(await run(deps, ['--help'])).toBe(EXIT.ok);
  });
});

describe('suppressions', () => {
  it('exits non-zero for a suppressed address so shells can branch on it', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/suppressions/bad%40example.com', {
      address: 'bad@example.com',
      reason: 'hard-bounce',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const code = await run(deps, ['suppressions', 'check', 'bad@example.com']);

    expect(code).toBe(EXIT.failed);
    expect(stdout).toContain('is suppressed');
  });

  it('reports a clean address as success', async () => {
    const { api, deps } = harness();
    api.failWith = new ApiError('Not found', 404, 'not_found');

    const code = await run(deps, ['suppressions', 'check', 'good@example.com']);

    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('is not suppressed');
  });

  it('validates the reason against the closed vocabulary', async () => {
    const { api, deps } = harness();

    const code = await run(deps, ['suppressions', 'add', 'x@example.com', '--reason', 'because']);

    expect(code).toBe(EXIT.usage);
    expect(api.calls).toHaveLength(0);
  });
});

describe('webhooks', () => {
  const rows = {
    data: [
      {
        key: 'SubscriptionChange',
        count: 4203,
        sample: '{"RecordType":"SubscriptionChange"}',
        firstSeenAt: '2026-08-01T09:12:00.000Z',
        lastSeenAt: '2026-09-14T16:40:00.000Z',
      },
    ],
  };

  it('renders the unhandled-event report as a table', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/webhooks/unhandled', rows);

    const code = await run(deps, ['webhooks', 'unhandled']);

    expect(code).toBe(EXIT.ok);
    expect(api.calls).toEqual([
      { method: 'GET', path: '/v1/webhooks/unhandled', query: undefined, body: undefined },
    ]);
    expect(stdout).toContain('SubscriptionChange');
    expect(stdout).toContain('4203');
    // Anything the operator did not ask for goes to stderr, so `--json >` stays
    // a clean document — but a non-empty report is worth saying out loud.
    expect(stderr).toContain('unhandled event type(s)');
  });

  it('prints the stored sample only when asked', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/webhooks/unhandled', rows);

    await run(deps, ['webhooks', 'unhandled']);
    expect(stdout).not.toContain('"RecordType"');

    stdout = '';
    await run(deps, ['webhooks', 'unhandled', '--samples']);
    expect(stdout).toContain('"RecordType":"SubscriptionChange"');
  });

  it('emits the raw API body under --json', async () => {
    const { api, deps } = harness();
    api.responses.set('/v1/webhooks/unhandled', rows);

    const code = await run(deps, ['webhooks', 'unhandled', '--json']);

    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toEqual(rows);
  });
});

describe('CABLEGRAM_TOKEN', () => {
  it('uses an explicit token from the environment and leaves the config untouched', async () => {
    const { api, deps, credentials } = harness(null);
    process.env.CABLEGRAM_URL = 'https://ci.example.com';
    process.env.CABLEGRAM_TOKEN = 'ci-token';
    api.responses.set('/v1/newsletters', { data: [], meta: { nextCursor: null } });

    const code = await run(deps, ['newsletters', 'list']);

    expect(code).toBe(EXIT.ok);
    // CI credentials are never persisted to the runner's home directory.
    expect(credentials()).toBeNull();
  });
});
