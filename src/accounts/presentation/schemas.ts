import { z } from '@hono/zod-openapi';
import { listResponseSchema } from '../../shared/http/index.js';
import { ROLES, type User } from '../domain/user.js';
import type { SessionTokens } from '../application/dtos.js';

/**
 * zod-OpenAPI schemas for the accounts API (ADR-013). Single source of truth
 * for both edge validation (ADR-006) and the generated OpenAPI spec (ADR-004).
 * The `User` response schema never carries `passwordHash` — the hash is not
 * part of the wire contract.
 */

const emailField = z
  .string()
  .trim()
  .email()
  .max(320)
  .openapi({ example: 'admin@cablegram.example' });

const newPasswordField = z
  .string()
  .min(8)
  .max(200)
  .openapi({ example: 'correct horse battery staple' });

const roleField = z.enum(ROLES).openapi({ example: 'manager' });

export const UserSchema = z
  .object({
    id: z.string().openapi({ example: 'b3f1c2a4-5d6e-7f80-91a2-b3c4d5e6f708' }),
    email: z.string().email().openapi({ example: 'admin@cablegram.example' }),
    role: roleField,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('User');

export const SetupSchema = z
  .object({ email: emailField, password: newPasswordField })
  .openapi('Setup');

export const CreateUserSchema = z
  .object({ email: emailField, password: newPasswordField, role: roleField })
  .openapi('CreateUser');

export const LoginSchema = z
  .object({ email: emailField, password: z.string().min(1).max(200) })
  .openapi('Login');

export const RefreshSchema = z
  .object({ refreshToken: z.string().min(1) })
  .openapi('Refresh');

export const LogoutSchema = z
  .object({ refreshToken: z.string().min(1) })
  .openapi('Logout');

const oneTimeTokenField = z.string().min(1).openapi({ example: 'M0v2…opaque-token' });

export const RequestPasswordResetSchema = z
  .object({ email: emailField })
  .openapi('RequestPasswordReset');

export const ResetPasswordSchema = z
  .object({ token: oneTimeTokenField, password: newPasswordField })
  .openapi('ResetPassword');

export const RequestMagicLinkSchema = z
  .object({ email: emailField })
  .openapi('RequestMagicLink');

export const ConsumeMagicLinkSchema = z
  .object({ token: oneTimeTokenField })
  .openapi('ConsumeMagicLink');

/**
 * The deliberately uniform body for the two non-enumerating request endpoints:
 * it is identical whether or not the address has an account, so the response
 * never reveals which (ADR-013/014).
 */
export const AcceptedSchema = z
  .object({ status: z.literal('accepted') })
  .openapi('Accepted');

export const SessionSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string(),
    refreshToken: z.string(),
    /** Access-token lifetime in seconds. */
    expiresIn: z.number().int(),
  })
  .openapi('Session');

export const UserListSchema = listResponseSchema(UserSchema, 'UserList');

export const UserIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: 'b3f1c2a4-5d6e-7f80-91a2-b3c4d5e6f708',
    }),
});

export type UserResponse = z.infer<typeof UserSchema>;

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export type SessionResponse = z.infer<typeof SessionSchema>;

/** Maps the use-case token pair to the wire session DTO. */
export function toSessionResponse(tokens: SessionTokens): SessionResponse {
  return {
    tokenType: 'Bearer',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresInSeconds,
  };
}
