import 'reflect-metadata';
import { buildContainer } from './shared/di/index.js';
import { createApp } from './app.js';

// DigitalOcean Functions entrypoint (ADR-009). The container and app are built
// once at module scope so warm invocations reuse them (ADR-003).
const app = createApp(buildContainer());

// DO Functions run on OpenWhisk; a raw "web" action receives the request via
// `__ow_*` fields and returns `{ statusCode, headers, body }`. The exact field
// mapping is confirmed against DigitalOcean's runtime docs at deploy — we keep
// provider specifics out of the domain and pin them here at the edge.
interface OpenWhiskWebArgs {
  __ow_method?: string;
  __ow_headers?: Record<string, string>;
  __ow_path?: string;
  __ow_query?: string;
  __ow_body?: string;
  __ow_isBase64Encoded?: boolean;
}

interface OpenWhiskWebResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function main(args: OpenWhiskWebArgs): Promise<OpenWhiskWebResult> {
  const method = (args.__ow_method ?? 'get').toUpperCase();
  const headers = args.__ow_headers ?? {};
  const path = args.__ow_path || '/';
  const query = args.__ow_query ? `?${args.__ow_query}` : '';
  const url = `http://cablegram.local${path}${query}`;

  const hasBody = args.__ow_body != null && method !== 'GET' && method !== 'HEAD';
  const body = hasBody
    ? args.__ow_isBase64Encoded
      ? Buffer.from(args.__ow_body as string, 'base64')
      : (args.__ow_body as string)
    : undefined;

  const res = await app.fetch(new Request(url, { method, headers, body }));

  return {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers),
    body: await res.text(),
  };
}
