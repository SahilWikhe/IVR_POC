import { z } from 'zod';
import { idSchema, roleSchema, restaurantSchema } from './base.js';

export const identityIssuerSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const issuer = new URL(value);
    return (
      issuer.protocol === 'https:' &&
      !issuer.username &&
      !issuer.password &&
      !issuer.search &&
      !issuer.hash
    );
  }, 'Identity issuer must be a fixed HTTPS URL.');
export const identitySubjectSchema = z.string().min(1).max(255);
export const identityClientIdSchema = z.string().min(1).max(255);
export const authTokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const tenantAccessSchema = z
  .object({
    version: z.number().int().positive(),
    enabled: z.boolean(),
    workspaceName: z.string().trim().min(1).max(100),
  })
  .strict();
export type TenantAccess = z.infer<typeof tenantAccessSchema>;

export const identityAccessReferenceSchema = z
  .object({
    issuer: identityIssuerSchema,
    subject: identitySubjectSchema,
    tenantId: idSchema,
  })
  .strict();
export const identityAccessSnapshotSchema = z
  .object({
    identity: z
      .object({
        id: idSchema,
        version: z.number().int().positive(),
        displayName: z.string().min(1).max(100),
        enabled: z.boolean(),
      })
      .strict()
      .nullable(),
    tenant: tenantAccessSchema.nullable(),
    membership: z
      .object({ version: z.number().int().positive(), role: roleSchema, enabled: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();
export const provisionIdentityAccessSchema = identityAccessReferenceSchema
  .extend({
    displayName: z.string().trim().min(1).max(100),
    workspaceName: z.string().trim().min(1).max(100),
    role: roleSchema,
    identityEnabled: z.boolean(),
    membershipEnabled: z.boolean(),
    tenantEnabled: z.boolean(),
    expectedIdentityVersion: z.number().int().positive().nullable(),
    expectedMembershipVersion: z.number().int().positive().nullable(),
    expectedTenantVersion: z.number().int().positive().nullable(),
  })
  .strict();
export type IdentityAccessReference = z.infer<typeof identityAccessReferenceSchema>;
export type IdentityAccessSnapshot = z.infer<typeof identityAccessSnapshotSchema>;
export type ProvisionIdentityAccess = z.infer<typeof provisionIdentityAccessSchema>;

export const restaurantOperatorReferenceSchema = z.object({ tenantId: idSchema }).strict();
export const restaurantOperatorSnapshotSchema = z
  .object({ restaurant: restaurantSchema.nullable(), tenantAccess: tenantAccessSchema.nullable() })
  .strict();
export const provisionRestaurantSchema = z
  .object({
    restaurant: restaurantSchema,
    tenantEnabled: z.boolean(),
    expectedRestaurantVersion: z.number().int().positive().nullable(),
    expectedTenantVersion: z.number().int().positive().nullable(),
  })
  .strict();
export type RestaurantOperatorReference = z.infer<typeof restaurantOperatorReferenceSchema>;
export type RestaurantOperatorSnapshot = z.infer<typeof restaurantOperatorSnapshotSchema>;
export type ProvisionRestaurant = z.infer<typeof provisionRestaurantSchema>;
