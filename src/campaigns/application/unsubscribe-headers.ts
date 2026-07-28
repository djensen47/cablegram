import type { AppConfig } from '../../shared/config/index.js';
import { unsubscribeToken } from '../../shared/auth/index.js';
import type { EmailHeader } from '../../shared/email/index.js';
import { PUBLIC_UNSUBSCRIBE_PATH } from '../../subscriptions/index.js';

/**
 * Build a recipient's RFC 8058 `List-Unsubscribe` headers (ADR-015). The URL
 * **always** points at the API's own `POST /v1/unsubscribe` (built from
 * `baseUrl`) — that is the machine one-click endpoint, and the token can only
 * travel per-recipient in the header (a campaign is one bulk send with a shared
 * body, ADR-008). Any operator `unsubscribe.url` page is reached by the API's
 * `GET` forwarding this token, not by pointing the header there. Returns
 * `undefined` when no `baseUrl` is set — nowhere to point, so headers are
 * omitted. `email` rides along for the landing page to display.
 *
 * A free function shared by the real send and the test send (ADR-025) rather
 * than a method on either: a test send that built its headers a second way
 * would not be proving the header a subscriber actually receives.
 */
export function unsubscribeHeaders(
  config: AppConfig,
  newsletterId: string,
  subscriptionId: string,
  email: string,
): readonly EmailHeader[] | undefined {
  if (config.baseUrl === null) return undefined;

  const token = unsubscribeToken(config.unsubscribe.tokenSecret, newsletterId, subscriptionId);
  const url = new URL(`${config.baseUrl}${PUBLIC_UNSUBSCRIBE_PATH}`);
  url.searchParams.set('newsletterId', newsletterId);
  url.searchParams.set('subscriptionId', subscriptionId);
  url.searchParams.set('token', token);
  url.searchParams.set('email', email);
  return [
    { name: 'List-Unsubscribe', value: `<${url.toString()}>` },
    { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
  ];
}
