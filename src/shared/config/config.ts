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
  /**
   * Email backend selection (ADR-008). Only `postmark` is supported today; the
   * field is a forward-looking seam so a second provider can be added without a
   * config reshape. It is wired to nothing yet — the composition root always
   * binds the Postmark gateway.
   */
  readonly email: {
    readonly provider: 'postmark';
  };
  readonly postmark: {
    /**
     * The **broadcast** server token, sent as `X-Postmark-Server-Token` on
     * broadcast (campaign) sends (ADR-008). Historically the only token.
     */
    readonly serverToken: string;
    /**
     * The **transactional** server token, used for transactional sends
     * (subscribe confirmations, account emails). In Postmark a token *is* a
     * server, so a separate transactional server has its own token. Resolved
     * with a fallback: when `POSTMARK_TRANSACTIONAL_SERVER_TOKEN` is unset this
     * equals `serverToken`, so a single-server setup keeps working unchanged.
     */
    readonly transactionalServerToken: string;
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
  /**
   * The sender identity for cablegram's own transactional account mail
   * (password-reset, magic-link — ADR-013/014). These emails have no newsletter
   * to borrow a `from` from, so a dedicated system identity is configured here.
   */
  readonly systemEmail: {
    /** `From` address for account mail; must be a Postmark-verified sender/domain. */
    readonly fromAddress: string;
    /** Display name for account mail (defaults to `cablegram`). */
    readonly fromName: string;
  };
  /**
   * How account emails present their reset / magic-link references (ADR-013/014).
   * cablegram is headless, so a link needs a front-end base URL the operator
   * provides. When `enabled` is false the email carries the raw token + the API
   * path instead, and the two base URLs are absent.
   */
  readonly accountLinks: {
    /** When true, account emails link to the configured base URLs (both required). */
    readonly enabled: boolean;
    /** Front-end base for the password-reset link; token appended as `?token=`. */
    readonly passwordResetUrlBase: string | null;
    /** Front-end base for the magic-link login; token appended as `?token=`. */
    readonly magicLinkUrlBase: string | null;
  };
  /** One-time email-token lifetimes (ADR-013/014); both tokens are single-use. */
  readonly oneTimeTokens: {
    /** Password-reset token lifetime in seconds (default 1h). */
    readonly passwordResetTtlSeconds: number;
    /** Magic-link login token lifetime in seconds (default 15m). */
    readonly magicLinkTtlSeconds: number;
  };
  /**
   * cablegram's own public origin (ADR-015), e.g. `https://api.example.com`. The
   * first URL the API needs to point at **itself** (unlike the account-mail bases,
   * which point at an operator front-end): it builds the absolute
   * `List-Unsubscribe` header + body-link URLs recipients hit. When it is unset,
   * campaign sends simply omit the `List-Unsubscribe` headers — sending is
   * unaffected. No trailing slash (normalized here).
   */
  readonly baseUrl: string | null;
  /** Public, token-authenticated unsubscribe settings (ADR-015). */
  readonly unsubscribe: {
    /**
     * HMAC secret for the stateless per-subscription unsubscribe token. In
     * Postmark-token style it **falls back to the JWT secret** when unset, so a
     * minimal deployment needs no extra config; setting it separately decouples
     * link validity from JWT-secret rotation (rotating one need not invalidate
     * the other). Rotating *this* secret invalidates all outstanding links.
     */
    readonly tokenSecret: string;
    /**
     * How the browser-facing unsubscribe GET responds. When true, it `302`s to
     * `redirectUrl` (with the address on the query string) after unsubscribing;
     * when false it renders a small generic confirmation page instead. The
     * mail-client one-click POST (RFC 8058) is unaffected — it always returns 200.
     */
    readonly redirectEnabled: boolean;
    /** Where the browser GET redirects on success; required when `redirectEnabled`. */
    readonly redirectUrl: string | null;
  };
}

/** Strip a single trailing slash so `${base}/v1/...` never doubles up. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    // HS256 needs a key at least as long as its 256-bit digest; require a
    // reasonably long secret so a weak key can never silently weaken signing.
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    // Email backend seam — only `postmark` is supported today (ADR-008).
    EMAIL_PROVIDER: z.enum(['postmark']).default('postmark'),
    POSTMARK_SERVER_TOKEN: z.string().min(1),
    // Optional distinct token for transactional sends; falls back to the
    // broadcast token below when unset (a single-server Postmark setup).
    POSTMARK_TRANSACTIONAL_SERVER_TOKEN: z.string().min(1).optional(),
    POSTMARK_WEBHOOK_SECRET: z.string().min(1),
    // System sender identity for cablegram's own account mail (ADR-013/014).
    SYSTEM_EMAIL_FROM_ADDRESS: z.string().email(),
    SYSTEM_EMAIL_FROM_NAME: z.string().min(1).default('cablegram'),
    // Account-email link presentation. `EMAIL_LINK_ENABLED` is an explicit
    // opt-in string flag (`true`); anything else (including unset) is false —
    // `z.coerce.boolean()` would wrongly treat the string `"false"` as true.
    EMAIL_LINK_ENABLED: z
      .string()
      .optional()
      .transform((v) => v?.toLowerCase() === 'true'),
    PASSWORD_RESET_URL_BASE: z.string().url().optional(),
    MAGIC_LINK_URL_BASE: z.string().url().optional(),
    PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
    MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    // The API's own public origin — needed to emit absolute List-Unsubscribe
    // links (ADR-015); when unset, campaign sends omit those headers.
    BASE_URL: z.string().url().optional(),
    // Optional dedicated HMAC secret for unsubscribe tokens; falls back to
    // JWT_SECRET below when unset (a single-secret deployment is unchanged).
    UNSUBSCRIBE_TOKEN_SECRET: z.string().min(1).optional(),
    // Same explicit-opt-in string flag shape as EMAIL_LINK_ENABLED — `z.coerce.
    // boolean()` would wrongly read the string "false" as true.
    UNSUBSCRIBE_REDIRECT_ENABLED: z
      .string()
      .optional()
      .transform((v) => v?.toLowerCase() === 'true'),
    UNSUBSCRIBE_REDIRECT_URL: z.string().url().optional(),
  })
  // When links are enabled, both front-end base URLs must be present — the email
  // has nowhere to point otherwise.
  .superRefine((e, ctx) => {
    if (!e.EMAIL_LINK_ENABLED) return;
    if (!e.PASSWORD_RESET_URL_BASE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASSWORD_RESET_URL_BASE'],
        message: 'is required when EMAIL_LINK_ENABLED is true',
      });
    }
    if (!e.MAGIC_LINK_URL_BASE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAGIC_LINK_URL_BASE'],
        message: 'is required when EMAIL_LINK_ENABLED is true',
      });
    }
  })
  // The unsubscribe redirect has nowhere to send the browser without a target.
  .superRefine((e, ctx) => {
    if (e.UNSUBSCRIBE_REDIRECT_ENABLED && !e.UNSUBSCRIBE_REDIRECT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UNSUBSCRIBE_REDIRECT_URL'],
        message: 'is required when UNSUBSCRIBE_REDIRECT_ENABLED is true',
      });
    }
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
    email: {
      provider: e.EMAIL_PROVIDER,
    },
    postmark: {
      serverToken: e.POSTMARK_SERVER_TOKEN,
      transactionalServerToken:
        e.POSTMARK_TRANSACTIONAL_SERVER_TOKEN ?? e.POSTMARK_SERVER_TOKEN,
      webhookSecret: e.POSTMARK_WEBHOOK_SECRET,
    },
    systemEmail: {
      fromAddress: e.SYSTEM_EMAIL_FROM_ADDRESS,
      fromName: e.SYSTEM_EMAIL_FROM_NAME,
    },
    accountLinks: {
      enabled: e.EMAIL_LINK_ENABLED,
      passwordResetUrlBase: e.PASSWORD_RESET_URL_BASE ?? null,
      magicLinkUrlBase: e.MAGIC_LINK_URL_BASE ?? null,
    },
    oneTimeTokens: {
      passwordResetTtlSeconds: e.PASSWORD_RESET_TTL_SECONDS,
      magicLinkTtlSeconds: e.MAGIC_LINK_TTL_SECONDS,
    },
    baseUrl: e.BASE_URL ? trimTrailingSlash(e.BASE_URL) : null,
    unsubscribe: {
      // Dedicated secret when provided, else the JWT secret (single-secret setup).
      tokenSecret: e.UNSUBSCRIBE_TOKEN_SECRET ?? e.JWT_SECRET,
      redirectEnabled: e.UNSUBSCRIBE_REDIRECT_ENABLED,
      redirectUrl: e.UNSUBSCRIBE_REDIRECT_URL ?? null,
    },
  };
}
