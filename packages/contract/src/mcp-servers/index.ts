import { z } from 'zod'

import { MAX_AGENTS_PER_WORKSPACE } from '../agents/index'
import { McpServerNameSchema, McpServerUrlSchema } from '../mcp/naming'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { truncateUtf8, utf8BoundedString } from '../utf8/index'

export const MAX_MCP_SERVER_LABEL_UTF8_BYTES = 384
export const MAX_MCP_DROPPED_TOOL_NAMES = 128
export const MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES = 1_024
export const McpServerLabelSchema = utf8BoundedString(
  MAX_MCP_SERVER_LABEL_UTF8_BYTES,
  'MCP server label',
)
  .min(1)
  .max(128)
export const McpDroppedToolNameSchema = utf8BoundedString(
  MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES,
  'Dropped MCP tool name',
).min(1)
export const McpDroppedToolNamesSchema = z
  .array(McpDroppedToolNameSchema)
  .max(MAX_MCP_DROPPED_TOOL_NAMES)

export function boundMcpDroppedToolNames(names: readonly string[]): string[] {
  return names
    .slice(0, MAX_MCP_DROPPED_TOOL_NAMES)
    .map(name => truncateUtf8(name, MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES))
    .filter(name => name.length > 0)
}

/**
 * Custom remote MCP servers a workspace attaches for itself, listed beside the
 * Composio-backed integration catalog but with a lifecycle of their own: no
 * provider session, no vendor catalog, no readiness gate. That is why they are
 * their own module rather than more fields on `integrations`.
 *
 * Nothing here may carry a credential. The tokens these servers need live in
 * Convex and are attached by Duet's proxy, server-side, per request. The one
 * allowlisted exception in the whole feature is a pasted static token on the
 * ADD REQUEST, and even that never comes back out on a response.
 */

/** How Duet authenticates to the server, as stored on the row. */
export const McpServerAuthKindSchema = z.enum(['none', 'oauth', 'static'])
export type McpServerAuthKind = z.infer<typeof McpServerAuthKindSchema>

export const McpServerStateSchema = z.enum([
  // OAuth server registered but not yet consented to.
  'needs_auth',
  'ready',
  // Terminal credential failure, reached from either auth kind: an expired
  // static paste and an `invalid_grant` refresh are one state with two roads in.
  'reauth_required',
  'disconnecting',
])
export type McpServerState = z.infer<typeof McpServerStateSchema>

/**
 * Health is a closed set of codes, never an upstream body — a body can carry
 * the very credential the split-out credential table exists to protect.
 */
export const McpServerErrorCodeSchema = z.enum([
  'unauthorized',
  'reauth_required',
  'unreachable',
  'upstream_error',
  'result_too_large',
  'timeout',
])
export type McpServerErrorCode = z.infer<typeof McpServerErrorCodeSchema>

const TimestampSchema = z.number().int().nonnegative()

const McpServerAgentPrincipalIdsSchema = z
  .array(z.string().min(1))
  .max(MAX_AGENTS_PER_WORKSPACE + 1)

export const McpServerSchema = z.object({
  // The name is the row's identity, not a display field: it is the tool-name
  // prefix, the proxy path segment, and the launch marker's only content.
  name: McpServerNameSchema,
  label: McpServerLabelSchema,
  url: McpServerUrlSchema,
  authKind: McpServerAuthKindSchema,
  state: McpServerStateSchema,
  // What the tools block actually costs this workspace per turn, measured once
  // at the probe. A turn never recomputes it.
  toolCount: z.number().int().nonnegative().optional(),
  estimatedPromptBytes: z.number().int().nonnegative().optional(),
  // Tools whose namespaced name would exceed the tool-name ceiling. They are
  // dropped rather than renamed, so the user is told which ones.
  droppedToolNames: McpDroppedToolNamesSchema.optional(),
  lastSuccessAt: TimestampSchema.optional(),
  lastErrorAt: TimestampSchema.optional(),
  lastErrorCode: McpServerErrorCodeSchema.optional(),
  allowedAgentIds: McpServerAgentPrincipalIdsSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type McpServer = z.infer<typeof McpServerSchema>

export const McpServerListQuerySchema = CollectionPageQuerySchema
export const McpServerListSchema = collectionPageSchema(McpServerSchema)
export type McpServerList = z.infer<typeof McpServerListSchema>

/**
 * How the caller says the server should be authenticated to.
 *
 * `static` is the pasted-token branch, and its `token` is THE ONE allowlisted
 * secret-bearing field in this feature — named explicitly in the schema-walk
 * test so a second one has to be a deliberate edit. It rides the ADD REQUEST
 * only; nothing hands it back out, and no response schema may grow a twin.
 *
 * There is deliberately no expiry field beside it. Duet cannot know when a
 * pasted token dies, and a user-entered guess would be a lie we then acted on.
 * The health signal is the expiry story: an upstream 401/403 sets
 * `lastErrorCode: 'reauth_required'`, the same terminal state the OAuth branch
 * reaches through `invalid_grant`.
 *
 * There is also no header-name field. A pasted token rides `Authorization`,
 * the scheme kept in the credential row's `tokenType`, because that is the
 * only shape `mcpServerCredentials` can hold. Offering a header name the
 * storage cannot persist would publish a field that silently does nothing;
 * adding one later, with the column that makes it real, is purely additive.
 */
export const McpServerRequestAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('oauth') }),
  z.object({ kind: z.literal('static'), token: z.string().min(1).max(8192) }),
])
export type McpServerRequestAuth = z.infer<typeof McpServerRequestAuthSchema>

/**
 * A dry run against the server before anything is written. The probe needs the
 * name because the dropped-tool answer depends on it: the ceiling applies to
 * `name__tool`, so the same server dropped different tools under a shorter one.
 */
export const McpServerProbeRequestSchema = z.object({
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  auth: McpServerRequestAuthSchema.optional(),
})
export type McpServerProbeRequest = z.infer<typeof McpServerProbeRequestSchema>

export const AddMcpServerRequestSchema = McpServerProbeRequestSchema.extend({
  label: McpServerLabelSchema.optional(),
})
export type AddMcpServerRequest = z.infer<typeof AddMcpServerRequestSchema>

export const McpServerProbeSchema = z.object({
  // What the server challenged with, not what the caller asked for: `none` is a
  // clean answer, `oauth` is a 401 carrying a challenge. An unreachable server
  // is a 4xx on the probe itself, so it has no success shape.
  auth: z.enum(['none', 'oauth']),
  toolCount: z.number().int().nonnegative(),
  estimatedPromptBytes: z.number().int().nonnegative(),
  droppedToolNames: McpDroppedToolNamesSchema.optional(),
  // Whether the authorization server offers Duet a way to obtain a client id.
  // Only meaningful when `auth` is `oauth`.
  registrationSupported: z.boolean().optional(),
})
export type McpServerProbe = z.infer<typeof McpServerProbeSchema>

export const SetMcpServerAgentPolicyRequestSchema = z.object({
  // Three states, not two: absent means every agent, an empty list means none,
  // and a populated list means exactly those.
  allowedAgentIds: McpServerAgentPrincipalIdsSchema.optional(),
})
export type SetMcpServerAgentPolicyRequest = z.infer<typeof SetMcpServerAgentPolicyRequestSchema>

export const McpServerAgentPolicyResponseSchema = z.object({
  name: McpServerNameSchema,
  allowedAgentIds: McpServerAgentPrincipalIdsSchema.optional(),
})
export type McpServerAgentPolicyResponse = z.infer<typeof McpServerAgentPolicyResponseSchema>

/**
 * What Duet ATTEMPTED, never what the authorization server did.
 *
 * RFC 7009 §2.2 makes a `200` mandatory for a token the server does not
 * recognize, so a success here is a request that was accepted — not a token
 * that is provably dead. Worse, slice 00 measured Linear, Notion and Sentry all
 * advertising their **token endpoint** as their revocation endpoint, which is
 * very likely boilerplate rather than a working RFC 7009 implementation. Duet
 * records the attempt and never presents `revoked` to a human as a fact about
 * the third party.
 *
 * `not_supported` covers every case where there was nothing to send: a static
 * pasted token (the user's to revoke at its source), a server with no
 * credential, and an authorization server that advertises no revocation
 * endpoint at all.
 */
export const McpRevocationAttemptSchema = z.enum(['revoked', 'not_supported', 'failed'])
export type McpRevocationAttempt = z.infer<typeof McpRevocationAttemptSchema>

/**
 * What happened to the RFC 7592 client registration, in terms of the ROW.
 *
 * `retained` is deliberately one value for two situations — another server in
 * this workspace still uses the registration, or the delete was refused — and
 * in both the row survives on purpose: a later connect to the same
 * authorization server reuses it (so no second orphan is minted) and a later
 * disconnect retries the delete. `not_supported` means there was never a
 * registration to delete: the CIMD branch registers nothing, and an
 * authorization server that answered DCR without RFC 7592 fields left no way to
 * ask.
 */
export const McpRegistrationCleanupSchema = z.enum(['deleted', 'retained', 'not_supported'])
export type McpRegistrationCleanup = z.infer<typeof McpRegistrationCleanupSchema>

export const RemoveMcpServerResponseSchema = z.object({
  name: McpServerNameSchema,
  removed: z.boolean(),
  revoked: McpRevocationAttemptSchema,
  registration: McpRegistrationCleanupSchema,
})
export type RemoveMcpServerResponse = z.infer<typeof RemoveMcpServerResponseSchema>
