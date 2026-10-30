import { z } from 'zod'

import { utf8BoundedString } from '../utf8/index'

/**
 * The name of the one MCP server Duet runs on the workspace's behalf: the
 * Composio-backed integration catalog. It is not a prefix constant — it is a
 * server name like any other, and the only one users may not claim.
 */
export const INTEGRATIONS_MCP_SERVER_NAME = 'integrations'

/**
 * The runner joins an MCP server's name to each of its tools with this
 * separator, and the model sees the joined string as the tool's name. Both
 * halves of that mapping — building the name and reading it back — live here so
 * nothing downstream re-derives either one from a hardcoded prefix.
 */
export const MCP_TOOL_NAME_SEPARATOR = '__'

/** The ceiling the model API imposes on a tool name, joined halves included. */
export const MCP_TOOL_NAME_MAX = 128

export const MAX_MCP_SERVERS_PER_WORKSPACE = 20
export const MAX_MCP_SERVER_URL_UTF8_BYTES = 6_144

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/
const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

/**
 * A server name is the runner's tool-name prefix, so it is this server's
 * identity everywhere: launch marker, proxy path, timeline chip.
 *
 * `__` is forbidden even though `_` is allowed: the name is joined to the tool
 * with `__`, so `my__server__TOOL` would have two valid decodings and
 * `splitNamespacedToolName` could not be the single owner of the mapping.
 *
 * `integrations` is reserved: `McpServersConfig` is a Record, so a server with
 * that name would silently displace the Composio entry rather than collide.
 */
export const McpServerNameSchema = z
  .string()
  .regex(MCP_SERVER_NAME_PATTERN, 'Server name must be 1-48 characters of a-z, A-Z, 0-9, _ or -')
  .refine(
    name => !name.includes(MCP_TOOL_NAME_SEPARATOR),
    `Server name must not contain "${MCP_TOOL_NAME_SEPARATOR}"`,
  )
  .refine(
    name => name !== INTEGRATIONS_MCP_SERVER_NAME,
    `"${INTEGRATIONS_MCP_SERVER_NAME}" is reserved`,
  )

/**
 * Duet's control plane fetches this URL on the user's behalf, so `https:` is a
 * floor rather than a preference. Everything else about where the URL may point
 * — loopback, link-local, private ranges, redirect hops — is a resolved-address
 * question the route's SSRF guard answers; a string schema cannot.
 */
export const McpServerUrlSchema = utf8BoundedString(MAX_MCP_SERVER_URL_UTF8_BYTES, 'MCP server URL')
  .min(1)
  .max(2048)
  .refine(value => {
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  }, 'Server URL must be an absolute https URL')

/** Encode a server's tool the way the runner exposes it to the model. */
export function namespacedToolName(server: string, tool: string): string {
  return `${server}${MCP_TOOL_NAME_SEPARATOR}${tool}`
}

/**
 * The single decoder for namespaced tool names. It answers non-null exactly
 * when the input could have been produced by `namespacedToolName` from a legal
 * server name and a legal tool name — so a bare tool name, or one whose prefix
 * is not a legal server name, reads as "not namespaced" rather than as a server
 * nobody registered.
 *
 * The split is on the FIRST separator. A server name cannot contain `__`, so
 * that split is exact even when the tool's own name carries one.
 *
 * `integrations` decodes like any other server: the reserved name is closed to
 * users at registration, not to the decoder, which must still name the chip.
 */
export function splitNamespacedToolName(name: string): { server: string; tool: string } | null {
  if (name.length > MCP_TOOL_NAME_MAX) return null
  const boundary = name.indexOf(MCP_TOOL_NAME_SEPARATOR)
  if (boundary <= 0) return null
  const server = name.slice(0, boundary)
  const tool = name.slice(boundary + MCP_TOOL_NAME_SEPARATOR.length)
  if (!MCP_SERVER_NAME_PATTERN.test(server)) return null
  if (!MCP_TOOL_NAME_PATTERN.test(tool)) return null
  return { server, tool }
}
