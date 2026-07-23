import { z } from 'zod';

/**
 * Application configuration, sourced from environment variables (ADR-009).
 * No config files on disk; secrets are injected by the platform.
 */
export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /**
   * JWT authentication settings (ADR-013). `/v1` is protected entirely by a
   * user **Bearer JWT** — there is no static API key. `secret` signs and
   * verifies the HS256 access token; the two TTLs bound the access token and
   * the opaque, server-stored refresh token respectively.
   */
  readonly jwt: {
    /** HS256 signing secret for access tokens. Must be a long, random string. */
    readonly secret: string;
    /** Access-token lifetime in seconds (short-lived; default 15m). */
    readonly accessTtlSeconds: number;
    /** Refresh-token lifetime in seconds (long-lived; default 30d). */
    readonly refreshTtlSeconds: number;
  };
  readonly postmark: {
    /** Server-level API token, sent as `X-Postmark-Server-Token` on sends (ADR-008). */
    readonly serverToken: string;
    /**
     * Shared secret guarding the inbound webhook endpoint. Postmark provides
     * **no** HMAC/signature verification (pinned against the live webhook docs);
     * its only native mechanisms are HTTP Basic Auth on the webhook URL and IP
     * allowlisting. So this is not a signature-verification key — it is the
     * Basic-Auth credential the webhook receiver (in `campaigns`) checks. It is
     * the **sole** exception to JWT-only auth (ADR-013): the webhook carries no
     * user identity. The `email` module never sees it: `parseProviderEvent`
     * only normalizes an already-authenticated body.
     */
    readonly webhookSecret: string;
  };
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // HS256 needs a key at least as long as its 256-bit digest; require a
  // reasonably long secret so a weak key can never silently weaken signing.
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  POSTMARK_SERVER_TOKEN: z.string().min(1),
  POSTMARK_WEBHOOK_SECRET: z.string().min(1),
});

/** Parse and validate configuration, throwing a readable error on any problem. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    jwt: {
      secret: e.JWT_SECRET,
      accessTtlSeconds: e.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: e.JWT_REFRESH_TTL_SECONDS,
    },
    postmark: {
      serverToken: e.POSTMARK_SERVER_TOKEN,
      webhookSecret: e.POSTMARK_WEBHOOK_SECRET,
    },
  };
}
