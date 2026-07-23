import type { Role } from '../domain/user.js';

/**
 * Application-layer input/output DTOs: plain, validated primitives handed to
 * use cases (ADR-006 — validation happens at the HTTP edge; use cases never see
 * a Hono `Context`). User output is the domain `User`, mapped to a response DTO
 * by the presentation layer; the token flows return `SessionTokens`.
 */

export interface RegisterInitialAdminInput {
  email: string;
  password: string;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: Role;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RefreshInput {
  refreshToken: string;
}

export interface LogoutInput {
  refreshToken: string;
}

export interface ListUsersInput {
  limit: number;
  cursor?: string;
}

/**
 * The token pair returned by login/refresh. `accessToken` is the short-lived
 * HS256 JWT; `refreshToken` is the opaque secret (shown once, stored only as a
 * hash). `expiresInSeconds` is the access token's lifetime.
 */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}
