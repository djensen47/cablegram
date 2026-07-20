/** Hono environment: request-scoped variables set by shared middleware. */
export type AppEnv = {
  Variables: {
    requestId: string;
  };
};
