import { z } from 'zod';

/**
 * Application configuration, sourced from environment variables (ADR-009).
 * No config files on disk; secrets are injected by the platform.
 */
export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly apiKeys: readonly string[];
  readonly postmark: {
    readonly serverToken: string;
    readonly webhookSecret: string;
  };
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  API_KEYS: z.string().min(1),
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
    apiKeys: e.API_KEYS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    postmark: {
      serverToken: e.POSTMARK_SERVER_TOKEN,
      webhookSecret: e.POSTMARK_WEBHOOK_SECRET,
    },
  };
}
