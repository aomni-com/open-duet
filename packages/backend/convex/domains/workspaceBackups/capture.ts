import { v, type Infer } from 'convex/values'

import type { Doc } from '../../_generated/dataModel'
import { query, type QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

export const MAX_CAPTURE_RECORD_BYTES = 1024 * 1024

type Warning = { code: string; recordKey?: string; detail: string }
const pageOptions = (cursor: string | null, numItems = 4) => ({
  cursor,
  numItems,
  maximumBytesRead: 1024 * 1024,
})

async function sessionRecord(ctx: QueryCtx, row: Doc<'agentSessions'>, warnings: Warning[]) {
  if (row.archiveState === 'deleting') {
    warnings.push({
      code: 'disappeared',
      recordKey: row._id,
      detail: 'Session is being deleted',
    })
    return null
  }
  if (row.agentId) {
    const agent = await ctx.db.get(row.agentId)
    if (!agent || agent.workspaceId !== row.workspaceId)
      warnings.push({
        code: 'dangling_metadata',
        recordKey: row._id,
        detail: 'Session agent is unavailable',
      })
  }
  if (row.createdBySessionId) {
    const parent = await ctx.db.get(row.createdBySessionId)
    if (!parent || parent.workspaceId !== row.workspaceId || parent.archiveState === 'deleting')
      warnings.push({
        code: 'dangling_metadata',
        recordKey: row._id,
        detail: 'Session parent is unavailable',
      })
  }
  return {
    kind: 'session' as const,
    key: row._id,
    title: row.title,
    prompt: row.prompt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    agentKey: row.agentId ?? 'root',
    parentKey: row.createdBySessionId,
    cwd: row.cwd,
    archived: row.archiveState === 'archived',
    archivedAt: row.archivedAt,
    visible: row.visible,
    onboarding: row.onboarding,
    modelId: row.lastModelId,
    todos: row.todos,
    followUps: row.followUpQueue,
    stateMachine: row.requestedMachine,
    eventCeiling: row.lastEventSeq,
    capturedAt: Date.now(),
  }
}

async function anchoredRecord(
  ctx: QueryCtx,
  row: Doc<'agents'> | Doc<'apps'>,
  warnings: Warning[],
) {
  const anchor = await ctx.db.get(row.anchorId)
  const path = anchor?.workspaceId === row.workspaceId ? anchor.path : null
  if (path === null)
    warnings.push({
      code: 'dangling_metadata',
      recordKey: row._id,
      detail: 'Drive anchor unavailable',
    })
  return {
    key: row._id,
    path,
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    disabled: row.disabledAt !== undefined,
  }
}

// Four source rows reserve room for their bounded point joins. JSON escaping can
// expand a legal Convex document; omit that record explicitly, never retry an
// unchanged cursor or silently truncate its content.
function boundedPage<
  T extends { records: object[]; warnings: Warning[]; nextCursor: string | null },
>(result: T): T {
  let remainingBytes = 8 * 1024 * 1024
  result.records = result.records.filter(record => {
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength
    if (bytes <= MAX_CAPTURE_RECORD_BYTES && bytes <= remainingBytes) {
      remainingBytes -= bytes
      return true
    }
    const recordKey =
      'key' in record
        ? String(record.key)
        : 'sessionKey' in record && 'seq' in record
          ? `${record.sessionKey}:${record.seq}`
          : undefined
    result.warnings.push({
      code: 'incomplete_collection',
      recordKey,
      detail: 'Record exceeds serialized export byte budget',
    })
    return false
  })
  return result
}

const captureArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  cutoff: v.number(),
  collection: v.union(
    v.literal('settings'),
    v.literal('sessions'),
    v.literal('events'),
    v.literal('images'),
    v.literal('mcpServers'),
    v.literal('toolkitPolicies'),
    v.literal('providers'),
    v.literal('agents'),
    v.literal('apps'),
  ),
  cursor: v.union(v.string(), v.null()),
  sessionId: v.optional(v.id('agentSessions')),
  ceiling: v.optional(v.number()),
})

export const page = query({
  args: captureArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (!Number.isFinite(args.cutoff) || args.cutoff < 0) throw new Error('Invalid capture cutoff')
    return boundedPage(await capturePage(ctx, args))
  },
})

async function capturePage(ctx: QueryCtx, args: Infer<typeof captureArgs>) {
  const row = await ctx.db.get(args.workspaceId)
  if (!row) throw new Error('Workspace unavailable')
  const warnings: Warning[] = []
  if (args.collection === 'settings')
    return {
      records: [
        {
          kind: 'settings' as const,
          name: row.name,
          slug: row.slug,
          assistantName: row.duetName,
          purpose: row.purpose,
          defaultModelId: row.defaultModelId,
          onboardedAt: row.onboardedAt,
          maxMonthlySpendMicroUsd: row.billing?.maxMonthlySpendMicroUsd,
        },
      ],
      warnings,
      nextCursor: null,
    }
  if (args.collection === 'agents') {
    const result = await ctx.db
      .query('agents')
      .withIndex('by_workspace', q =>
        q.eq('workspaceId', args.workspaceId).lte('_creationTime', args.cutoff),
      )
      .paginate(pageOptions(args.cursor))
    const records = []
    for (const agent of result.page)
      records.push({
        kind: 'agent' as const,
        ...(await anchoredRecord(ctx, agent, warnings)),
        onboardedAt: agent.onboardedAt,
        defaultSessionKey: agent.defaultSessionId,
      })
    return { records, warnings, nextCursor: result.isDone ? null : result.continueCursor }
  }
  if (args.collection === 'apps') {
    const result = await ctx.db
      .query('apps')
      .withIndex('by_workspace', q =>
        q.eq('workspaceId', args.workspaceId).lte('_creationTime', args.cutoff),
      )
      .paginate(pageOptions(args.cursor))
    const records = []
    for (const app of result.page)
      records.push({
        kind: 'app' as const,
        ...(await anchoredRecord(ctx, app, warnings)),
        command: app.command,
        installCommand: app.installCommand,
        port: app.port,
        apiScopes: app.apiScopes,
        visibility: app.visibility,
      })
    return { records, warnings, nextCursor: result.isDone ? null : result.continueCursor }
  }
  if (args.collection === 'mcpServers') {
    const result = await ctx.db
      .query('mcpServers')
      .withIndex('by_workspace', q =>
        q.eq('workspaceId', args.workspaceId).lte('_creationTime', args.cutoff),
      )
      .paginate(pageOptions(args.cursor))
    const records = []
    for (const server of result.page) {
      const policy = await ctx.db
        .query('mcpServerAgentPolicies')
        .withIndex('by_workspace_and_server', q =>
          q.eq('workspaceId', args.workspaceId).eq('serverId', server._id),
        )
        .unique()
      const credential =
        server.authKind === 'static'
          ? await ctx.db
              .query('mcpServerCredentials')
              .withIndex('by_server', q => q.eq('serverId', server._id))
              .unique()
          : null
      const token =
        credential?.kind === 'static' && credential.workspaceId === args.workspaceId
          ? credential.accessToken
          : undefined
      if (server.authKind === 'static' && !token)
        warnings.push({
          code: 'dangling_metadata',
          recordKey: server._id,
          detail: 'Static MCP credential unavailable',
        })
      records.push({
        kind: 'mcpServer' as const,
        key: server._id,
        name: server.name,
        label: server.label,
        url: server.url,
        authKind: server.authKind,
        token,
        allowedAgentIds: policy?.allowedAgentIds,
        reconnectRequired: server.authKind === 'oauth',
      })
    }
    return { records, warnings, nextCursor: result.isDone ? null : result.continueCursor }
  }
  if (args.collection === 'toolkitPolicies') {
    const result = await ctx.db
      .query('integrationAgentPolicies')
      .withIndex('by_workspace', q =>
        q.eq('workspaceId', args.workspaceId).lte('_creationTime', args.cutoff),
      )
      .paginate(pageOptions(args.cursor, 128))
    return {
      records: result.page.map(policy => ({
        kind: 'toolkitPolicy' as const,
        toolkitSlug: policy.toolkitSlug,
        allowedAgentIds: policy.allowedAgentIds,
      })),
      warnings,
      nextCursor: result.isDone ? null : result.continueCursor,
    }
  }
  if (args.collection === 'providers') {
    const result = await ctx.db
      .query('connectedProviders')
      .withIndex('by_workspace', q =>
        q.eq('workspaceId', args.workspaceId).lte('_creationTime', args.cutoff),
      )
      .paginate(pageOptions(args.cursor, 128))
    return {
      records: result.page.map(provider => ({
        kind: 'provider' as const,
        provider: provider.provider,
        reconnectRequired: true,
      })),
      warnings,
      nextCursor: result.isDone ? null : result.continueCursor,
    }
  }
  if (args.collection === 'events' || args.collection === 'images') {
    if (!args.sessionId) throw new Error('Session required')
    const session = await ctx.db.get(args.sessionId)
    if (!session)
      return {
        records: [],
        warnings: [
          { code: 'disappeared', recordKey: args.sessionId, detail: 'Session unavailable' },
        ],
        nextCursor: null,
      }
    if (session.workspaceId !== args.workspaceId) throw new Error('Session unavailable')
    if (session.archiveState === 'deleting')
      return {
        records: [],
        warnings: [
          {
            code: 'disappeared',
            recordKey: session._id,
            detail: 'Session is being deleted',
          },
        ],
        nextCursor: null,
      }
    if (args.collection === 'events') {
      if (args.ceiling === undefined || !Number.isSafeInteger(args.ceiling) || args.ceiling < 0)
        throw new Error('Captured event ceiling required')
      const result = await ctx.db
        .query('agentSessionEvents')
        .withIndex('by_session_seq', q => q.eq('sessionId', session._id).lte('seq', args.ceiling!))
        .paginate(pageOptions(args.cursor, 128))
      const records = result.page
        .filter(event => {
          if (event.workspaceId === args.workspaceId) return true
          warnings.push({
            code: 'dangling_metadata',
            recordKey: event._id,
            detail: 'Event ownership mismatch',
          })
          return false
        })
        .map(event => ({
          kind: 'event' as const,
          sessionKey: session._id,
          seq: event.seq,
          createdAt: event.createdAt,
          event: event.event,
        }))
      return { records, warnings, nextCursor: result.isDone ? null : result.continueCursor }
    }
    const result = await ctx.db
      .query('agentSessionImages')
      .withIndex('by_session', q =>
        q.eq('sessionId', session._id).lte('_creationTime', args.cutoff),
      )
      .paginate(pageOptions(args.cursor, 128))
    const records = []
    for (const image of result.page) {
      if (image.workspaceId !== args.workspaceId) {
        warnings.push({
          code: 'dangling_metadata',
          recordKey: image._id,
          detail: 'Image ownership mismatch',
        })
        continue
      }
      const sourceUrl = await ctx.storage.getUrl(image.storageId)
      if (!sourceUrl) {
        warnings.push({
          code: 'missing_image',
          recordKey: image.storageId,
          detail: 'Image bytes unavailable',
        })
        continue
      }
      records.push({
        kind: 'image' as const,
        sessionKey: session._id,
        storageId: image.storageId,
        mimeType: image.mimeType,
        bytes: image.bytes,
        sourceUrl,
      })
    }
    return { records, warnings, nextCursor: result.isDone ? null : result.continueCursor }
  }
  const result = await ctx.db
    .query('agentSessions')
    .withIndex('by_workspace', q =>
      q.eq('workspaceId', args.workspaceId).lte('_creationTime', args.cutoff),
    )
    .paginate(pageOptions(args.cursor))
  const records = []
  for (const session of result.page) {
    const record = await sessionRecord(ctx, session, warnings)
    if (record) records.push(record)
  }
  return { records, warnings, nextCursor: result.isDone ? null : result.continueCursor }
}

export type CapturePage = Awaited<ReturnType<typeof capturePage>>
