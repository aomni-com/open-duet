import type { McpServerErrorCode } from '@repo/contract'

import type { McpProxyOutcome, McpUpstreamSource } from './proxy'

/**
 * A custom MCP server as an upstream for the shared forwarder: where its
 * credential comes from, and what its answer says about its health.
 *
 * The credential is read per request and never cached. A cached copy would be a
 * second owner of a token whose whole point is that one table holds it, and it
 * would go stale against a rotation it cannot see.
 */

/**
 * What the proxy attaches, once `mcp/refresh.ts` has decided whether the stored
 * token is still good. Nothing here is a token's owner: this is the shape that
 * crosses from the credential path to the byte path and no further.
 */
export interface StoredMcpCredential {
  kind: 'oauth' | 'static'
  accessToken: string
  tokenType?: string
}

export interface McpServerHealthSignal {
  outcome: 'success' | 'error'
  errorCode?: McpServerErrorCode
}

export interface CustomMcpUpstreamDeps {
  server: { name: string; url: string }
  requestMethod: string
  readCredential: () => Promise<StoredMcpCredential | null>
  recordHealth: (signal: McpServerHealthSignal) => Promise<unknown>
  /**
   * `waitUntil`. Health is D10's feedback channel, not part of answering the
   * tool call: the write touches the same `mcpServers` index range every
   * dispatch in this workspace reads, so putting it on the critical path would
   * both slow the call and set the proxy against the agent's own turns.
   */
  schedule: (promise: Promise<unknown>) => void
}

export function customMcpUpstreamSource(deps: CustomMcpUpstreamDeps): McpUpstreamSource {
  return {
    sourceId: `mcp-server:${deps.server.name}`,
    async resolve() {
      return {
        url: deps.server.url,
        headers: credentialHeaders(await deps.readCredential()),
      }
    },
    settled(outcome) {
      // MCP permits 405 for optional event streams and session termination.
      // These responses say nothing about whether tool requests are healthy.
      if (
        outcome.status === 405 &&
        (deps.requestMethod === 'GET' || deps.requestMethod === 'DELETE')
      )
        return
      deps.schedule(
        deps.recordHealth(healthFromOutcome(outcome)).catch((error: unknown) => {
          // A lost health write is a lost observation, never a failed tool
          // call: the response has already gone back to the runner.
          console.warn('[mcp-proxy] health write failed', {
            server: deps.server.name,
            error: error instanceof Error ? error.message : String(error),
          })
        }),
      )
    },
  }
}

/**
 * A server with no credential row is fetched with no credential.
 *
 * That covers both a `none` server, which never had one, and an OAuth server
 * nobody has consented to yet — and the second is deliberately not a special
 * case here. The upstream's own 401 is a truer answer than a guess made from
 * the row's state, and it lands in the health field as `unauthorized` where the
 * user can see it.
 */
export function credentialHeaders(credential: StoredMcpCredential | null): Record<string, string> {
  if (credential === null) return {}
  const tokenType = credential.tokenType ?? 'Bearer'
  // Some servers (Linear) issue lowercase token_type but require canonical
  // Bearer casing in requests. Normalize at use so existing grants work too.
  const scheme = tokenType.toLowerCase() === 'bearer' ? 'Bearer' : tokenType
  return { authorization: `${scheme} ${credential.accessToken}` }
}

/**
 * D10's closed enum, derived from what the proxy saw. Never an upstream body:
 * a body can quote the very credential the credential table exists to protect.
 *
 * A capped result is recorded as an error rather than a success because it is
 * the one outcome the user cannot otherwise discover — the tool answered, the
 * model got a truncated version of it, and nothing else in the product would
 * ever say so.
 */
export function healthFromOutcome(outcome: McpProxyOutcome): McpServerHealthSignal {
  if (outcome.failure === 'unreachable') return { outcome: 'error', errorCode: 'unreachable' }
  if (outcome.failure === 'oversized_frame') {
    return { outcome: 'error', errorCode: 'upstream_error' }
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { outcome: 'error', errorCode: 'unauthorized' }
  }
  if (outcome.status === 408 || outcome.status === 504) {
    return { outcome: 'error', errorCode: 'timeout' }
  }
  if (outcome.status >= 400) return { outcome: 'error', errorCode: 'upstream_error' }
  if (outcome.cappedFrom !== undefined) {
    return { outcome: 'error', errorCode: 'result_too_large' }
  }
  return { outcome: 'success' }
}
