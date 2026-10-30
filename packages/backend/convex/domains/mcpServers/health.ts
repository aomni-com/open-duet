import { v } from 'convex/values'

import { McpServerErrorCodeSchema } from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import { mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { mcpServerByName } from './model'

/**
 * D10's feedback channel: the proxy is the only writer of a server's health.
 *
 * With tool filtering off the table, a server that fails is otherwise invisible
 * — the runner warns it away and the user is never told. These three fields are
 * the whole story the row can tell, and they are CODES, never bodies: an
 * upstream error body can quote the very credential the separate credential
 * table exists to protect.
 */

/**
 * How long a run of identical observations may be coalesced into one write.
 *
 * This is not merely a cost optimization. Every turn's delivery mutation reads
 * this workspace's whole `mcpServers` index range to build the launch marker,
 * so a per-request health write would put the proxy in optimistic-concurrency
 * conflict with every message, answer, note and drain in the workspace — a busy
 * agent would retry its own dispatch against its own tool calls. Anything that
 * CHANGES what a reader sees still lands immediately; only the steady state is
 * coalesced.
 */
const MCP_HEALTH_COALESCE_WINDOW_MS = 60_000

export const recordMcpServerHealth = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    name: v.string(),
    outcome: v.union(v.literal('success'), v.literal('error')),
    errorCode: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await mcpServerByName(ctx, args.workspaceId, args.name)
    if (server === null) return { recorded: false }
    const now = args.now ?? Date.now()
    if (args.outcome === 'success') {
      if (!shouldRecordSuccess(server, now)) return { recorded: false }
      await ctx.db.patch(server._id, { lastSuccessAt: now, updatedAt: now })
      return { recorded: true }
    }
    // An unrecognized code is stored as `upstream_error` rather than passed
    // through: the closed set is what makes this field safe to render, and a
    // caller-supplied string is how a body leaks in one field at a time.
    const parsed = McpServerErrorCodeSchema.safeParse(args.errorCode)
    const lastErrorCode = parsed.success ? parsed.data : 'upstream_error'
    if (!shouldRecordError(server, lastErrorCode, now)) return { recorded: false }
    await ctx.db.patch(server._id, { lastErrorAt: now, lastErrorCode, updatedAt: now })
    return { recorded: true }
  },
})

/**
 * A success is worth a write when it is the first one, when it is a RECOVERY —
 * the last thing this server did was fail, so the row currently reads broken —
 * or when the last recorded success has aged out of the window.
 */
function shouldRecordSuccess(server: Doc<'mcpServers'>, now: number): boolean {
  if (server.lastSuccessAt === undefined) return true
  if (server.lastErrorAt !== undefined && server.lastErrorAt > server.lastSuccessAt) return true
  return now - server.lastSuccessAt >= MCP_HEALTH_COALESCE_WINDOW_MS
}

/**
 * A failure is worth a write when it is the first one, when the CODE changed —
 * `unauthorized` becoming `unreachable` is a different problem to report — when
 * it is a REGRESSION from a row that currently reads healthy, or when the last
 * recorded failure has aged out of the window. The regression case mirrors the
 * recovery one above: without it, a server that fails again with the same code
 * it failed with before would keep a newer success timestamp and go on reading
 * healthy while it is broken.
 */
function shouldRecordError(server: Doc<'mcpServers'>, errorCode: string, now: number): boolean {
  if (server.lastErrorAt === undefined) return true
  if (server.lastErrorCode !== errorCode) return true
  if (server.lastSuccessAt !== undefined && server.lastSuccessAt > server.lastErrorAt) return true
  return now - server.lastErrorAt >= MCP_HEALTH_COALESCE_WINDOW_MS
}
