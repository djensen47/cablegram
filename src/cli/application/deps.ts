import type { ApiClient } from './api-client.js';
import type { CredentialStore, StoredCredentials } from './credential-store.js';

/**
 * The CLI's dependency seam (ADR-016 §2).
 *
 * `presentation/` may import `application/` but not `infrastructure/` (ADR-005),
 * so the command layer depends on these interfaces and `main.ts` — the component
 * element, which may import both — supplies the concrete `FetchApiClient` and
 * `FileCredentialStore`. That is the same inversion the server gets from
 * Inversify, done with a plain object because the CLI's whole graph is two
 * collaborators built once at process start (ADR-003 is a server concern).
 *
 * It is also what makes the command tests cheap: they pass a stub client and an
 * in-memory store and never open a socket or touch the operator's config.
 */
export interface CliDeps {
  store: CredentialStore;
  /** Builds a client bound to a session. Called after credentials are resolved. */
  createClient(credentials: StoredCredentials): ApiClient;
  /** Injected so tests can pin time rather than race token expiry. */
  now(): Date;
}
