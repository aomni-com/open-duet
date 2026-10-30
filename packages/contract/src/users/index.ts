import { z } from 'zod'

import { ApiKeyNameStorageSchema } from '../api-keys/index'
import { SyncthingDeviceIdSchema } from '../mirror/index'
import { OAuthGrantStorageMetadataSchema } from '../oauth/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { WorkspaceSlugSchema } from '../slug/index'

export const UserProfileSchema = z.object({
  id: z.string(),
  email: z.email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional(),
})
export type UserProfile = z.infer<typeof UserProfileSchema>

export const UserProfileUpdateRequestSchema = z.object({
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
})

const UserApiKeySchema = z.object({
  id: z.string(),
  name: ApiKeyNameStorageSchema.optional(),
  prefix: z.string(),
  createdAt: z.number().positive(),
  expiresAt: z.number().positive().optional(),
  lastUsedAt: z.number().positive().optional(),
  revokedAt: z.number().positive().optional(),
})
export type UserApiKey = z.infer<typeof UserApiKeySchema>

export const UserApiKeyListQuerySchema = CollectionPageQuerySchema
export const UserApiKeyPageSchema = collectionPageSchema(UserApiKeySchema)
export const UserApiKeyIssueRequestSchema = z.strictObject({
  name: ApiKeyNameStorageSchema,
  expiresAt: z.number().int().positive().optional(),
})
export const UserApiKeyIssuedSchema = z.object({
  key: z.string(),
  record: UserApiKeySchema,
})
export const UserApiKeyRevokedSchema = z.object({
  prefix: z.string(),
  revokedAt: z.number().int().positive(),
})

// OAuth grants are an authorization relationship, not API keys. This
// projection deliberately excludes access/refresh material and family state.
export const OAuthGrantSchema = z.object({
  id: z.string(),
  clientId: OAuthGrantStorageMetadataSchema.shape.clientId,
  clientName: OAuthGrantStorageMetadataSchema.shape.clientName,
  redirectHost: OAuthGrantStorageMetadataSchema.shape.redirectHost,
  workspace: z.object({
    slug: WorkspaceSlugSchema,
    name: OAuthGrantStorageMetadataSchema.shape.workspaceName,
  }),
  scopes: OAuthGrantStorageMetadataSchema.shape.scopes,
  createdAt: z.number().positive(),
  lastUsedAt: z.number().positive().optional(),
  revokedAt: z.number().positive().optional(),
})
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>

export const OAuthGrantListQuerySchema = CollectionPageQuerySchema
export const OAuthGrantPageSchema = collectionPageSchema(OAuthGrantSchema)
export const OAuthGrantRevokedSchema = z.object({
  grantId: z.string(),
  revokedAt: z.number().int().positive(),
})

// Machine identity is non-secret and survives replacement of the user's key.
export const SyncMachineSchema = z.object({
  machineId: z.string().min(1),
  name: ApiKeyNameStorageSchema,
  syncthingDeviceId: SyncthingDeviceIdSchema,
  createdAt: z.number().positive(),
  lastUsedAt: z.number().positive(),
  removedAt: z.number().positive().optional(),
})
export type SyncMachine = z.infer<typeof SyncMachineSchema>
export const SyncMachineRegisterRequestSchema = z.strictObject({
  name: ApiKeyNameStorageSchema,
  syncthingDeviceId: SyncthingDeviceIdSchema,
})
export const SyncMachineListQuerySchema = CollectionPageQuerySchema
export const SyncMachinePageSchema = collectionPageSchema(SyncMachineSchema)
export const SyncMachineRemovedSchema = z.object({
  ok: z.literal(true),
  machineId: z.string().min(1),
  removedAt: z.number().int().positive(),
})
