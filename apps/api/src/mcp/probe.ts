import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  MCP_TOOL_NAME_MAX,
  boundMcpDroppedToolNames,
  namespacedToolName,
  type FetchLike,
  type McpServerRequestAuth,
} from '@repo/contract'

import { BlockedUpstreamUrlError, guardedFetch, type HostResolver } from './ssrf'

/**
 * The dry run a server gets before Duet writes a row for it.
 *
 * It answers three questions the user is about to be asked to accept: does this
 * server work with the credential offered, what will its tools cost every turn,
 * and — if it wants OAuth — can Duet obtain a client id at all. A probe that
 * fails leaves nothing behind, which is the whole reason it exists separately
 * from the add.
 */

export interface McpProbeOutcome {
  /** What the server CHALLENGED with, not what the caller asked for. */
  auth: 'none' | 'oauth'
  toolCount: number
  estimatedPromptBytes: number
  droppedToolNames: string[]
  /** D7's gate. Only meaningful when `auth` is `oauth`. */
  registrationSupported?: boolean
  /**
   * The consent scope this server wants, selected once here so slice 09 has
   * one owner for the rule. Deliberately not on the wire: nothing outside the
   * OAuth flow has any use for it.
   */
  scope?: string
}

export type McpProbeFailureCode =
  /* The URL is one Duet's control plane must not fetch. */
  | 'blocked'
  /* Reached, and refused the credential offered — with no OAuth challenge to
     fall forward onto. A rejected paste lands here. */
  | 'unauthorized'
  /* Nothing usable answered: DNS, TLS, a 5xx, or a non-MCP endpoint. */
  | 'unreachable'

export class McpProbeFailure extends Error {
  constructor(
    readonly code: McpProbeFailureCode,
    readonly detail?: string,
  ) {
    super(`mcp probe failed (${code})`)
    this.name = 'McpProbeFailure'
  }
}

export interface McpProbeOptions {
  name: string
  url: string
  auth: McpServerRequestAuth
  fetchImpl: FetchLike
  resolveHost?: HostResolver
}

export async function probeMcpServer(options: McpProbeOptions): Promise<McpProbeOutcome> {
  const guarded = guardedFetch(options.fetchImpl, options.resolveHost)
  // The challenge is read off the wire rather than off the thrown error: the
  // SDK reports a 401 as a status and a body, and RFC 9728's answer — where
  // the resource metadata lives, and what scope to ask for — is in the header
  // it discards. Watching every response costs one closure and no extra hop.
  let challenge: string | undefined
  let lastStatus: number | undefined
  const watched: FetchLike = async (input, init) => {
    const response = await guarded(input, init)
    lastStatus = response.status
    challenge = response.headers.get('www-authenticate') ?? challenge
    return response
  }

  try {
    return await measureTools(options, watched)
  } catch (error) {
    if (error instanceof BlockedUpstreamUrlError) throw new McpProbeFailure('blocked', error.reason)
    if (challenge !== undefined) return await classifyOAuth(options, watched, challenge)
    if (lastStatus === 401 || lastStatus === 403) {
      throw new McpProbeFailure('unauthorized', String(lastStatus))
    }
    throw new McpProbeFailure('unreachable', error instanceof Error ? error.message : String(error))
  }
}

async function measureTools(
  options: McpProbeOptions,
  fetchImpl: FetchLike,
): Promise<McpProbeOutcome> {
  const client = new Client({ name: 'duet', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: fetchImpl,
    ...(options.auth.kind === 'static'
      ? { requestInit: { headers: { authorization: `Bearer ${options.auth.token}` } } }
      : {}),
  })
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    // D8's casualty list. A tool whose namespaced name exceeds the model API's
    // ceiling is dropped rather than renamed — a renamed tool is a different
    // tool to the model and to every transcript that already mentions it — so
    // the user is told which ones by name.
    const dropped = tools.filter(
      tool => namespacedToolName(options.name, tool.name).length > MCP_TOOL_NAME_MAX,
    )
    const carried = tools.filter(tool => !dropped.includes(tool))
    return {
      auth: 'none',
      toolCount: carried.length,
      // What actually rides the tools block, which is what the row promises to
      // show. Dropped tools are excluded because they never reach the model,
      // so billing the user for their bytes would overstate the turn.
      estimatedPromptBytes: Buffer.byteLength(JSON.stringify(carried), 'utf8'),
      droppedToolNames: boundMcpDroppedToolNames(dropped.map(tool => tool.name)),
    }
  } finally {
    // Leaving the transport open would strand an SSE stream per probe, and a
    // probe is a one-shot question.
    await client.close().catch(() => undefined)
  }
}

/**
 * A challenged server, read for the two things D7 needs: whether Duet can get
 * a client id at all, and what scope to ask the human to consent to.
 *
 * Nothing is measured here. The tools of a server Duet cannot yet authenticate
 * to are unknown, and reporting zero as if it were a count would understate
 * every OAuth server's cost until the day it connects.
 */
async function classifyOAuth(
  options: McpProbeOptions,
  fetchImpl: FetchLike,
  challenge: string,
): Promise<McpProbeOutcome> {
  const params = parseChallenge(challenge)
  const base: McpProbeOutcome = {
    auth: 'oauth',
    toolCount: 0,
    estimatedPromptBytes: 0,
    droppedToolNames: [],
    registrationSupported: false,
  }
  try {
    const info = await discoverOAuthServerInfo(options.url, {
      ...(params.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: new URL(params.resourceMetadataUrl) }),
      fetchFn: fetchImpl,
    })
    // `authorizationServerMetadata`, NOT `metadata` — reading the latter yields
    // undefined for every field and is indistinguishable from a server that
    // advertises nothing. Slice 00 lost a debugging cycle to exactly this.
    const metadata = info.authorizationServerMetadata
    return {
      ...base,
      // CIMD **or** DCR. This is D7's gate, not a statement about DCR: every
      // OAuth-capable server slice 00 tested advertises CIMD and three of them
      // would read as unsupported under a DCR-shaped test, sending the user to
      // a token fallback they do not need.
      registrationSupported:
        metadata?.client_id_metadata_document_supported === true ||
        typeof metadata?.registration_endpoint === 'string',
      ...scopeOf(params.scope ?? info.resourceMetadata?.scopes_supported?.join(' ')),
    }
  } catch {
    // Discovery is how Duet would obtain a client id, so a discovery that
    // fails IS an unregistrable server — false, not unknown.
    return { ...base, ...scopeOf(params.scope) }
  }
}

function scopeOf(scope: string | undefined): { scope?: string } {
  return scope === undefined || scope.length === 0 ? {} : { scope }
}

/**
 * The `WWW-Authenticate` challenge, for the two parameters that matter.
 *
 * Scope selection follows the MCP authorization spec: the challenge's own
 * `scope` first, the protected-resource metadata's `scopes_supported` second,
 * and otherwise nothing — asking for a scope the server never named is how an
 * authorization request gets refused outright.
 */
function parseChallenge(challenge: string): { resourceMetadataUrl?: string; scope?: string } {
  const field = (name: string): string | undefined =>
    new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1] || undefined
  return {
    ...(field('resource_metadata') === undefined
      ? {}
      : { resourceMetadataUrl: field('resource_metadata') }),
    ...(field('scope') === undefined ? {} : { scope: field('scope') }),
  }
}
