import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authTokenHashSchema,
  identityClientIdSchema,
  identityIssuerSchema,
  identitySubjectSchema,
  idSchema,
  roleSchema,
} from '@hostline/contracts';

export interface IdentitySqlClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}
export const authSessionBindingSchema = z
  .object({
    tokenHash: authTokenHashSchema,
    issuer: identityIssuerSchema,
    clientId: identityClientIdSchema,
  })
  .strict();
export type AuthSessionBinding = z.infer<typeof authSessionBindingSchema>;
export const authSessionSchema = z
  .object({
    sessionId: idSchema,
    identityId: idSchema,
    tenantId: idSchema,
    role: roleSchema,
    displayName: z.string().min(1).max(100),
    workspaceName: z.string().min(1).max(100),
    expiresAt: z.iso.datetime({ offset: true }),
    idleExpiresAt: z.iso.datetime({ offset: true }),
    mfaVerifiedAt: z.iso.datetime({ offset: true }).nullable(),
    identityVersion: z.number().int().positive(),
    membershipVersion: z.number().int().positive(),
    tenantVersion: z.number().int().positive(),
  })
  .strict();
export type AuthSession = z.infer<typeof authSessionSchema>;
export const loginAttemptBindingSchema = authSessionBindingSchema
  .extend({ redirectUri: z.url().max(2048) })
  .strict();
export const createLoginAttemptSchema = loginAttemptBindingSchema
  .extend({
    encryptedPayload: z.string().min(1).max(16384),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const issueSessionSchema = authSessionBindingSchema
  .extend({
    subject: identitySubjectSchema,
    loginAttempt: loginAttemptBindingSchema,
    tenantId: idSchema.optional(),
    expiresAt: z.iso.datetime({ offset: true }),
    mfaVerifiedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const consumedLoginSchema = z
  .object({
    encryptedPayload: z.string().min(1).max(16384),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LoginAttemptBinding = z.infer<typeof loginAttemptBindingSchema>;
export type CreateLoginAttempt = z.infer<typeof createLoginAttemptSchema>;
export type IssueSession = z.infer<typeof issueSessionSchema>;
export type ConsumedLoginAttempt = z.infer<typeof consumedLoginSchema>;

export interface AuthPersistence {
  createLoginAttempt(input: CreateLoginAttempt): Promise<void>;
  consumeLoginAttempt(input: LoginAttemptBinding): Promise<ConsumedLoginAttempt | null>;
  cancelLoginAttempt(input: LoginAttemptBinding): Promise<void>;
  issueSession(input: IssueSession): Promise<AuthSession | null>;
  getSession(input: AuthSessionBinding): Promise<AuthSession | null>;
  revokeSession(input: AuthSessionBinding): Promise<void>;
}
export async function readAuthSession(
  client: IdentitySqlClient,
  input: AuthSessionBinding,
): Promise<AuthSession | null> {
  const binding = authSessionBindingSchema.parse(input);
  const value = (
    await client.query('SELECT public.auth_read_session($1,$2,$3) AS result', [
      binding.tokenHash,
      binding.issuer,
      binding.clientId,
    ])
  ).rows[0]?.['result'];
  return value === null || value === undefined ? null : authSessionSchema.parse(value);
}
export function createAuthPersistence(
  run: <T>(work: (client: IdentitySqlClient) => Promise<T>) => Promise<T>,
  unavailable: () => Error,
): AuthPersistence {
  return {
    async createLoginAttempt(input) {
      const value = createLoginAttemptSchema.parse(input);
      const result = await run((client) =>
        client.query('SELECT public.auth_create_login($1,$2,$3,$4,$5,$6::timestamptz) AS created', [
          value.tokenHash,
          value.issuer,
          value.clientId,
          value.redirectUri,
          value.encryptedPayload,
          value.expiresAt,
        ]),
      );
      if (result.rows[0]?.['created'] !== true) throw unavailable();
    },
    async consumeLoginAttempt(input) {
      const value = loginAttemptBindingSchema.parse(input);
      const result = (
        await run((client) =>
          client.query('SELECT public.auth_consume_login($1,$2,$3,$4) AS result', [
            value.tokenHash,
            value.issuer,
            value.clientId,
            value.redirectUri,
          ]),
        )
      ).rows[0]?.['result'];
      return result === null || result === undefined ? null : consumedLoginSchema.parse(result);
    },
    async cancelLoginAttempt(input) {
      const value = loginAttemptBindingSchema.parse(input);
      await run((client) =>
        client.query('SELECT public.auth_cancel_login($1,$2,$3,$4)', [
          value.tokenHash,
          value.issuer,
          value.clientId,
          value.redirectUri,
        ]),
      );
    },
    async issueSession(input) {
      const value = issueSessionSchema.parse(input);
      if (
        value.loginAttempt.issuer !== value.issuer ||
        value.loginAttempt.clientId !== value.clientId
      )
        return null;
      const result = (
        await run((client) =>
          client.query(
            'SELECT public.auth_issue_session($1,$2::uuid,$3,$4,$5,$6::uuid,$7::timestamptz,$8::timestamptz,$9,$10) AS result',
            [
              value.tokenHash,
              randomUUID(),
              value.issuer,
              value.clientId,
              value.subject,
              value.tenantId ?? null,
              value.expiresAt,
              value.mfaVerifiedAt ?? null,
              value.loginAttempt.tokenHash,
              value.loginAttempt.redirectUri,
            ],
          ),
        )
      ).rows[0]?.['result'];
      return result === null || result === undefined ? null : authSessionSchema.parse(result);
    },
    getSession(input) {
      return run((client) => readAuthSession(client, input));
    },
    async revokeSession(input) {
      const value = authSessionBindingSchema.parse(input);
      await run((client) =>
        client.query('SELECT public.auth_revoke_session($1,$2,$3)', [
          value.tokenHash,
          value.issuer,
          value.clientId,
        ]),
      );
    },
  };
}
