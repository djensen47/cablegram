// Facade for the cli component (ADR-002/005/016): import only from here.
//
// This component is an HTTP **client** of the /v1 API — it imports no domain
// component, opens no database connection, and reads no server secret. Nothing
// in the deployed server imports it, so it adds nothing to the function bundle.
export type { ApiClient, ApiRequest, ListEnvelope } from './application/api-client.js';
export { ApiError } from './application/api-error.js';
export type { CredentialStore, StoredCredentials } from './application/credential-store.js';
export type { CliDeps } from './application/deps.js';
export { credentialsFromSession, decodeClaims, isAccessTokenExpired } from './application/session.js';
export { FetchApiClient } from './infrastructure/fetch-api-client.js';
export { FileCredentialStore, defaultConfigPath } from './infrastructure/file-credential-store.js';
export { buildProgram, run, EXIT, CLI_VERSION } from './presentation/program.js';
