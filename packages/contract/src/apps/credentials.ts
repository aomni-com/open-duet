import { z } from 'zod'

import { DUET_API_KEY_PREFIX } from '../api-keys/fields'

export const MAX_EXPORTED_APP_CREDENTIALS = 5

export const AppCredentialExpirationSchema = z.union([
  z.literal('never'),
  z.strictObject({
    seconds: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  }),
])
export type AppCredentialExpiration = z.infer<typeof AppCredentialExpirationSchema>

export const ExportAppCredentialRequestSchema = z.strictObject({
  expiration: AppCredentialExpirationSchema,
})
export const AppCredentialRecordSchema = z.object({
  credentialId: z.string().min(1),
  prefix: z.string().startsWith(DUET_API_KEY_PREFIX),
  createdAt: z.number().nonnegative(),
  expiresAt: z.number().int().positive().nullable(),
})
export const ExportAppCredentialResponseSchema = AppCredentialRecordSchema.extend({
  key: z.string().startsWith(DUET_API_KEY_PREFIX),
  apiUrl: z.url({ protocol: /^https?$/ }),
  gatewayBaseUrl: z.url({ protocol: /^https?$/ }),
})
export const AppCredentialListQuerySchema = z.strictObject({})
export const AppCredentialListResponseSchema = z.object({
  items: z.array(AppCredentialRecordSchema).max(MAX_EXPORTED_APP_CREDENTIALS),
  nextCursor: z.null(),
})
export const RevokeAppCredentialResponseSchema = z.object({ ok: z.literal(true) })

export const AppCredentialErrorSchema = z.union([
  z.object({
    error: z.enum([
      'unauthorized',
      'forbidden',
      'invalid_request',
      'not_found',
      'internal_error',
      'app_disabled',
      'app_has_no_api_scopes',
      'app_credentials_not_configured',
    ]),
  }),
  z.object({ error: z.literal('insufficient_scope'), scope: z.string() }),
  z.object({
    error: z.literal('app_credential_limit'),
    limit: z.literal(MAX_EXPORTED_APP_CREDENTIALS),
  }),
])
