import { z } from 'zod'

import { MAX_AGENTS_PER_WORKSPACE } from '../agents/index'
import {
  COLLECTION_PAGE_MAX_LIMIT,
  CollectionPageQuerySchema,
  collectionPageSchema,
} from '../pagination/index'
import { WorkspaceSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'

export const MAX_INTEGRATION_SLUG_UTF8_BYTES = 128
export const MAX_INTEGRATION_AGENT_ID_UTF8_BYTES = 512
export const MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES = 512
export const MAX_INTEGRATION_CATALOG_DESCRIPTION_UTF8_BYTES = 4 * 1024
export const MAX_INTEGRATION_LOGO_URL_UTF8_BYTES = 4 * 1024
export const MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES = 512
export const MAX_INTEGRATION_AUTHORIZE_URL_UTF8_BYTES = 16 * 1024
export const MAX_INTEGRATION_PROVIDER_CURSOR_UTF8_BYTES = 512
export const MAX_INTEGRATION_PUBLIC_CURSOR_UTF8_BYTES = 8 * 1024

const IntegrationProviderCursorSchema = utf8BoundedString(
  MAX_INTEGRATION_PROVIDER_CURSOR_UTF8_BYTES,
  'Integration provider cursor',
).min(1)
const IntegrationPublicCursorSchema = utf8BoundedString(
  MAX_INTEGRATION_PUBLIC_CURSOR_UTF8_BYTES,
  'Integration cursor',
).min(1)

export const IntegrationSlugSchema = z
  .string()
  .trim()
  .min(1)
  .pipe(utf8BoundedString(MAX_INTEGRATION_SLUG_UTF8_BYTES, 'Integration slug'))

const IntegrationAgentPrincipalIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .pipe(utf8BoundedString(MAX_INTEGRATION_AGENT_ID_UTF8_BYTES, 'Integration agent ID')),
  )
  .max(MAX_AGENTS_PER_WORKSPACE + 1)

export const SetIntegrationAgentPolicyRequestSchema = z.object({
  allowedAgentIds: IntegrationAgentPrincipalIdsSchema.optional(),
})
export type SetIntegrationAgentPolicyRequest = z.infer<
  typeof SetIntegrationAgentPolicyRequestSchema
>

export const IntegrationAgentPolicyResponseSchema = z.object({
  integration: IntegrationSlugSchema,
  allowedAgentIds: IntegrationAgentPrincipalIdsSchema.optional(),
})
export type IntegrationAgentPolicyResponse = z.infer<typeof IntegrationAgentPolicyResponseSchema>

export const ComposioExecuteRequestSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
  workspace: WorkspaceSlugSchema.optional(),
})

// Composio tools have provider-defined response bodies. Duet deliberately
// forwards that value without imposing a tool-specific response grammar.
export const ComposioExecuteResponseSchema = z.unknown()

export const IntegrationCatalogQuerySchema = CollectionPageQuerySchema.extend({
  cursor: IntegrationPublicCursorSchema.optional(),
  q: z.string().trim().max(200).optional(),
})
export type IntegrationCatalogQuery = {
  q?: string
  cursor?: string
  limit?: number
}

export const IntegrationCatalogItemSchema = z.object({
  integration: IntegrationSlugSchema,
  name: utf8BoundedString(MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES, 'Integration name').min(1),
  description: utf8BoundedString(
    MAX_INTEGRATION_CATALOG_DESCRIPTION_UTF8_BYTES,
    'Integration description',
  ).optional(),
  logoUrl: z
    .url()
    .pipe(utf8BoundedString(MAX_INTEGRATION_LOGO_URL_UTF8_BYTES, 'Integration logo URL'))
    .optional(),
  connected: z.boolean(),
})
export type IntegrationCatalogItem = z.infer<typeof IntegrationCatalogItemSchema>

export const IntegrationCatalogPageSchema = collectionPageSchema(
  IntegrationCatalogItemSchema,
).extend({
  items: z.array(IntegrationCatalogItemSchema).max(COLLECTION_PAGE_MAX_LIMIT),
  nextCursor: IntegrationPublicCursorSchema.nullable(),
})
export type IntegrationCatalogPage = z.infer<typeof IntegrationCatalogPageSchema>

export const IntegrationProviderCatalogPageSchema = collectionPageSchema(
  IntegrationCatalogItemSchema,
).extend({
  items: z.array(IntegrationCatalogItemSchema).max(COLLECTION_PAGE_MAX_LIMIT),
  nextCursor: IntegrationProviderCursorSchema.nullable(),
})
export type IntegrationProviderCatalogPage = z.infer<typeof IntegrationProviderCatalogPageSchema>

export const IntegrationConnectRequestSchema = z.object({
  integration: IntegrationSlugSchema,
  redirectTo: z.string().min(1).max(2048),
})
export type IntegrationConnectRequest = z.infer<typeof IntegrationConnectRequestSchema>

const IntegrationConnectionStatusSchema = z.enum(['active', 'pending', 'error', 'disconnected'])

export const IntegrationConnectionIdSchema = utf8BoundedString(
  MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES,
  'Integration connection ID',
).min(1)

export const IntegrationConnectionSchema = z.object({
  id: IntegrationConnectionIdSchema,
  integration: IntegrationSlugSchema,
  name: utf8BoundedString(MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES, 'Integration name')
    .min(1)
    .optional(),
  logoUrl: z
    .url()
    .pipe(utf8BoundedString(MAX_INTEGRATION_LOGO_URL_UTF8_BYTES, 'Integration logo URL'))
    .optional(),
  status: IntegrationConnectionStatusSchema,
  connectedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  allowedAgentIds: IntegrationAgentPrincipalIdsSchema.optional(),
})
export type IntegrationConnection = z.infer<typeof IntegrationConnectionSchema>

export const IntegrationProviderConnectionSchema = IntegrationConnectionSchema.omit({
  allowedAgentIds: true,
})
export type IntegrationProviderConnection = z.infer<typeof IntegrationProviderConnectionSchema>
export const IntegrationProviderConnectionPageSchema = collectionPageSchema(
  IntegrationProviderConnectionSchema,
).extend({
  items: z.array(IntegrationProviderConnectionSchema).max(COLLECTION_PAGE_MAX_LIMIT),
  nextCursor: IntegrationProviderCursorSchema.nullable(),
})

export const IntegrationConnectResponseSchema = z.object({
  integration: IntegrationSlugSchema,
  authorizeUrl: z
    .url()
    .pipe(utf8BoundedString(MAX_INTEGRATION_AUTHORIZE_URL_UTF8_BYTES, 'Authorization URL'))
    .refine(value => value.startsWith('https://'), 'authorizeUrl must use HTTPS'),
})
export type IntegrationConnectResponse = z.infer<typeof IntegrationConnectResponseSchema>

export const IntegrationConnectionListQuerySchema = CollectionPageQuerySchema.extend({
  cursor: IntegrationPublicCursorSchema.optional(),
})
export const IntegrationConnectionListSchema = collectionPageSchema(
  IntegrationConnectionSchema,
).extend({
  items: z.array(IntegrationConnectionSchema).max(COLLECTION_PAGE_MAX_LIMIT),
  nextCursor: IntegrationPublicCursorSchema.nullable(),
})

export const IntegrationDisconnectResponseSchema = z.object({
  id: IntegrationConnectionIdSchema,
  disconnected: z.boolean(),
})

export const IntegrationProviderFailureErrorSchema = z.union([
  z
    .object({ error: z.literal('integration_provider_failed') })
    .describe('The integration provider rejected or returned invalid data (502)'),
  z
    .object({ error: z.literal('integration_provider_not_configured') })
    .describe('The integration provider is not configured for this deployment (503)'),
])
const IntegrationInvalidRequestErrorSchema = z
  .object({ error: z.literal('invalid_request') })
  .describe('The integration request or provider identity is outside the accepted contract (400)')
export const IntegrationCollectionErrorSchema = z.union([
  IntegrationProviderFailureErrorSchema,
  IntegrationInvalidRequestErrorSchema,
])
export const IntegrationConnectErrorSchema = z.union([
  IntegrationProviderFailureErrorSchema,
  IntegrationInvalidRequestErrorSchema,
  z
    .object({ error: z.literal('integration_already_connected') })
    .describe('This integration already has an active connection (409)'),
  z
    .object({ error: z.literal('redirect_not_allowed') })
    .describe('The requested browser return destination is not allowed (400)'),
])
export const IntegrationDisconnectErrorSchema = z.union([
  IntegrationProviderFailureErrorSchema,
  IntegrationInvalidRequestErrorSchema,
])
export const IntegrationAgentPolicyErrorSchema = IntegrationInvalidRequestErrorSchema
