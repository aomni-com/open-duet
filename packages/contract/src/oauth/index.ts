import { z } from 'zod'

import { CapabilityListSchema, CapabilitySchema, StoredApiKeyScopesSchema } from '../scopes/index'
import { WorkspaceSlugSchema } from '../slug/index'
import { utf8BoundedString } from '../utf8/index'
import { WorkspaceNameSchema, WorkspaceRoleSchema } from '../workspaces/index'

export const MAX_OAUTH_CLIENT_NAME_UTF8_BYTES = 256
export const MAX_OAUTH_CLIENT_METADATA_ARRAY_ITEMS = 16
export const MAX_OAUTH_URI_UTF8_BYTES = 4_096
export const MAX_OAUTH_METADATA_STRING_UTF8_BYTES = 512
export const MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES = 4_096
export const OAuthAuthorizationStateSchema = utf8BoundedString(
  MAX_OAUTH_AUTHORIZATION_STATE_UTF8_BYTES,
  'OAuth authorization state',
)

const OAuthBoundedUriSchema = z.url().pipe(utf8BoundedString(MAX_OAUTH_URI_UTF8_BYTES, 'OAuth URI'))
const OAuthClientNameSchema = z
  .string()
  .trim()
  .min(1)
  .pipe(utf8BoundedString(MAX_OAUTH_CLIENT_NAME_UTF8_BYTES, 'OAuth client name'))
const OAuthMetadataStringSchema = utf8BoundedString(
  MAX_OAUTH_METADATA_STRING_UTF8_BYTES,
  'OAuth metadata string',
)

const HttpsUrlSchema = OAuthBoundedUriSchema.refine(
  value => new URL(value).protocol === 'https:',
  'HTTPS required',
)

// A redirect URI is a browser navigation target: it MUST be HTTPS or an
// HTTP loopback (native clients), and never an executable scheme. Without
// this floor a `javascript:`/`data:` redirect_uri passes exact-match and
// reaches window.location.assign — script execution in the Duet page. Matches
// OAuth 2.1 / MCP: redirect URIs are localhost or HTTPS. One owner for
// registration, authorize, and token requests.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
export const OAuthRedirectUriSchema = OAuthBoundedUriSchema.refine(value => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}, 'redirect_uri must be HTTPS or an HTTP loopback address')
const AuthorizationServerIssuerSchema = HttpsUrlSchema.refine(value => {
  const issuer = new URL(value)
  return issuer.search === '' && issuer.hash === ''
}, 'Issuer must not contain a query or fragment')

export const AuthorizationServerMetadataSchema = z.object({
  issuer: AuthorizationServerIssuerSchema,
  authorization_endpoint: HttpsUrlSchema,
  token_endpoint: HttpsUrlSchema,
  registration_endpoint: HttpsUrlSchema,
  scopes_supported: CapabilityListSchema.min(1),
  response_types_supported: z.tuple([z.literal('code')]),
  grant_types_supported: z.tuple([z.literal('authorization_code'), z.literal('refresh_token')]),
  token_endpoint_auth_methods_supported: z.tuple([z.literal('none')]),
  code_challenge_methods_supported: z.tuple([z.literal('S256')]),
  protected_resources: z.array(HttpsUrlSchema).min(1),
})

export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>

export const ProtectedResourceMetadataSchema = z.object({
  resource: HttpsUrlSchema,
  authorization_servers: z.array(AuthorizationServerIssuerSchema).min(1),
  scopes_supported: CapabilityListSchema.min(1),
  bearer_methods_supported: z.tuple([z.literal('header')]),
})

export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadataSchema>

const OAuthScopeStringSchema = utf8BoundedString(
  MAX_OAUTH_METADATA_STRING_UTF8_BYTES,
  'OAuth scope',
).refine(scope => {
  const scopes = scope.split(' ')
  return (
    scopes.length > 0 &&
    scopes.every(
      (candidate, index) =>
        CapabilitySchema.safeParse(candidate).success && scopes.indexOf(candidate) === index,
    )
  )
}, 'Invalid OAuth scope')

const PublicClientMetadataSchema = z.object({
  redirect_uris: z.array(OAuthRedirectUriSchema).min(1).max(MAX_OAUTH_CLIENT_METADATA_ARRAY_ITEMS),
  token_endpoint_auth_method: z.literal('none'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2)
    .refine(grants => grants.includes('authorization_code'), 'authorization_code is required'),
  response_types: z.tuple([z.literal('code')]),
  client_name: OAuthClientNameSchema,
  client_uri: OAuthBoundedUriSchema.optional(),
  logo_uri: OAuthBoundedUriSchema.optional(),
  scope: OAuthScopeStringSchema.optional(),
  contacts: z
    .array(z.email().pipe(OAuthMetadataStringSchema))
    .max(MAX_OAUTH_CLIENT_METADATA_ARRAY_ITEMS)
    .optional(),
  tos_uri: OAuthBoundedUriSchema.optional(),
  policy_uri: OAuthBoundedUriSchema.optional(),
  software_id: OAuthMetadataStringSchema.optional(),
  software_version: OAuthMetadataStringSchema.optional(),
})

export const DynamicClientRegistrationRequestSchema = PublicClientMetadataSchema
export type DynamicClientRegistrationRequest = z.infer<
  typeof DynamicClientRegistrationRequestSchema
>

export const DynamicClientRegistrationResponseSchema = PublicClientMetadataSchema.extend({
  client_id: OAuthMetadataStringSchema.min(1),
  client_id_issued_at: z.number().int().nonnegative().optional(),
})
export type DynamicClientRegistrationResponse = z.infer<
  typeof DynamicClientRegistrationResponseSchema
>

/** The normalized DCR subset that the durable client registry stores. */
export const OAuthClientStorageSchema = z
  .object({
    clientId: OAuthMetadataStringSchema.min(1),
    clientName: OAuthClientNameSchema,
    redirectUris: z.array(OAuthRedirectUriSchema).min(1).max(MAX_OAUTH_CLIENT_METADATA_ARRAY_ITEMS),
    tokenEndpointAuthMethod: z.literal('none'),
    source: z.literal('dcr'),
  })
  .strict()

/** All variable-size fields copied onto a durable OAuth grant. */
export const OAuthGrantStorageMetadataSchema = z
  .object({
    clientId: OAuthMetadataStringSchema.min(1),
    clientName: OAuthClientNameSchema,
    redirectHost: OAuthMetadataStringSchema.min(1),
    capabilities: CapabilityListSchema.min(1),
    scopes: StoredApiKeyScopesSchema.min(1),
    audience: OAuthBoundedUriSchema,
    workspaceSlug: WorkspaceSlugSchema,
    workspaceName: WorkspaceNameSchema,
  })
  .strict()

export const DynamicClientRegistrationErrorResponseSchema = z.object({
  error: z.enum([
    'invalid_redirect_uri',
    'invalid_client_metadata',
    'invalid_software_statement',
    'unapproved_software_statement',
  ]),
  error_description: z.string().optional(),
})
export type DynamicClientRegistrationErrorResponse = z.infer<
  typeof DynamicClientRegistrationErrorResponseSchema
>

const PkceCodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const PkceCodeVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)

export const OAuthAuthorizationRequestSchema = z.object({
  response_type: z.literal('code'),
  client_id: OAuthMetadataStringSchema.min(1),
  redirect_uri: OAuthRedirectUriSchema,
  scope: OAuthScopeStringSchema,
  state: OAuthAuthorizationStateSchema.optional(),
  resource: OAuthBoundedUriSchema,
  code_challenge: PkceCodeChallengeSchema,
  code_challenge_method: z.literal('S256'),
})
export type OAuthAuthorizationRequest = z.infer<typeof OAuthAuthorizationRequestSchema>

export const OAuthAuthorizationResponseSchema = z.object({
  code: z.string().min(1),
  state: OAuthAuthorizationStateSchema.optional(),
})
export type OAuthAuthorizationResponse = z.infer<typeof OAuthAuthorizationResponseSchema>

const OAuthAuthorizationErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
])

const OAuthErrorDetailsSchema = z.object({
  error_description: z.string().optional(),
  error_uri: z.url().optional(),
})

export const OAuthAuthorizationErrorResponseSchema = OAuthErrorDetailsSchema.extend({
  error: OAuthAuthorizationErrorCodeSchema,
  state: OAuthAuthorizationStateSchema.optional(),
})
export type OAuthAuthorizationErrorResponse = z.infer<typeof OAuthAuthorizationErrorResponseSchema>

export const OAuthTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: OAuthRedirectUriSchema,
    client_id: OAuthMetadataStringSchema.min(1),
    code_verifier: PkceCodeVerifierSchema,
    resource: OAuthBoundedUriSchema,
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: OAuthMetadataStringSchema.min(1),
    resource: OAuthBoundedUriSchema,
  }),
])
export type OAuthTokenRequest = z.infer<typeof OAuthTokenRequestSchema>

export const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  scope: OAuthScopeStringSchema,
})
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>

export const OAuthTokenErrorResponseSchema = OAuthErrorDetailsSchema.extend({
  error: z.enum([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
  ]),
})
export type OAuthTokenErrorResponse = z.infer<typeof OAuthTokenErrorResponseSchema>

export const OAuthConsentInspectResponseSchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  client: z.object({
    id: OAuthMetadataStringSchema.min(1),
    name: OAuthClientNameSchema,
  }),
  redirect: z.object({
    hostname: z.string().min(1),
    localhost: z.boolean(),
  }),
  capabilities: CapabilityListSchema.min(1),
  workspaces: z.array(
    z.object({
      slug: WorkspaceSlugSchema,
      name: z.string().min(1),
      role: WorkspaceRoleSchema,
    }),
  ),
  expiresAt: z.number().int().positive(),
})
export type OAuthConsentInspectResponse = z.infer<typeof OAuthConsentInspectResponseSchema>

export const OAuthConsentApproveRequestSchema = z.object({
  workspaceSlug: WorkspaceSlugSchema,
})

export type OAuthConsentApproveRequest = z.infer<typeof OAuthConsentApproveRequestSchema>

const OAuthConsentCompletionSchema = z.object({
  redirectUrl: z.url(),
})

export const OAuthConsentApproveResponseSchema = OAuthConsentCompletionSchema
export type OAuthConsentApproveResponse = z.infer<typeof OAuthConsentApproveResponseSchema>

export const OAuthConsentDenyRequestSchema = z.object({})
export type OAuthConsentDenyRequest = z.infer<typeof OAuthConsentDenyRequestSchema>

export const OAuthConsentDenyResponseSchema = OAuthConsentCompletionSchema
export type OAuthConsentDenyResponse = z.infer<typeof OAuthConsentDenyResponseSchema>
