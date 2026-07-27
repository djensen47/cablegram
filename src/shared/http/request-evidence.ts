import { isIP } from 'node:net';
import type { Context } from 'hono';

/**
 * What a request itself says about who sent it (ADR-023) — an IP and a
 * user-agent, both unverified.
 *
 * **This is deliberately not used on `/v1` writes.** cablegram is headless
 * (ADR-004): every `/v1` route is called by the operator's own backend holding a
 * JWT, never by a subscriber's browser. Reading the IP there would record the
 * operator's server as the person who consented — not merely useless, but false
 * evidence, which is worse than a blank field. Those routes take the subscriber's
 * IP explicitly in the request body, because the operator is the one holding the
 * real request.
 *
 * The single legitimate caller is the **public unsubscribe** (ADR-015), where the
 * request genuinely originates with the recipient or their mail client.
 */
export interface RequestEvidence {
  ip?: string;
  userAgent?: string;
}

/**
 * There is no socket to read. On DigitalOcean Functions the entrypoint rebuilds
 * a `Request` from OpenWhisk's `__ow_headers` (ADR-009), so a forwarding header
 * is the only thing that can carry a client address at all.
 *
 * `X-Forwarded-For` is a list, appended to by each hop: the **leftmost** entry is
 * the original client, which is what we want — and also the only entry a client
 * can freely invent, since nothing upstream verifies it. That is why this is
 * recorded as corroborating detail rather than as proof, and why a value that is
 * not a valid IP is dropped instead of stored: a field that sometimes holds an
 * address and sometimes holds junk is not evidence of anything.
 */
export function requestEvidence(c: Context): RequestEvidence {
  const forwarded = c.req.header('x-forwarded-for');
  const claimed = forwarded?.split(',')[0]?.trim();
  const ip = claimed !== undefined && isIP(claimed) !== 0 ? claimed : undefined;

  const userAgent = c.req.header('user-agent')?.slice(0, 500);

  return { ip, userAgent: userAgent === undefined || userAgent === '' ? undefined : userAgent };
}
