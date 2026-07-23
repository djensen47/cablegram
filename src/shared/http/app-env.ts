/** The authenticated caller established by `jwtAuth` (ADR-013). */
export interface AuthContext {
  /** The user id from the access token's `sub` claim. */
  userId: string;
  /** The user's role from the access token (`admin` | `manager`, opaque here). */
  role: string;
}

/** Hono environment: request-scoped variables set by shared middleware. */
export type AppEnv = {
  Variables: {
    requestId: string;
    /**
     * Set by `jwtAuth` on authenticated `/v1` routes; absent on the open
     * routes (`/v1/setup`, `/v1/auth/*`) and on `/health`/`/openapi.json`.
     */
    auth?: AuthContext;
  };
};
