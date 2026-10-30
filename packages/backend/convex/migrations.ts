import { Migrations } from '@convex-dev/migrations'

import { bucketOf, isTranscriptEvent } from '@repo/contract'

import { components } from './_generated/api'
import type { DataModel, Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import {
  patchSessionAndReconcileDiscovery,
  reconcileSessionDiscovery,
} from './domains/agentSessions/discovery'
import { backfillWorkspaceSpendingRow } from './domains/credits/workspaceSpend'
import { ensureWorkspaceShareDirectoryEntry } from './domains/shares/directory'
import { reslugArchivedWorkspaceCollision } from './domains/workspaces/internal'
import {
  memberDirectorySearchText,
  writeMemberDirectoryEntry,
} from './domains/workspaces/memberDirectory'

export const migrations = new Migrations<DataModel>(components.migrations)

export const backfillWorkspaceSpending = migrations.define({
  table: 'workspaces',
  batchSize: 50,
  migrateOne: backfillWorkspaceSpendingRow,
})

export const backfillUserDirectoryRevision280826 = migrations.define({
  table: 'users',
  batchSize: 100,
  migrateOne: async (ctx, user) => {
    if ((user as { memberDirectoryRevision?: number }).memberDirectoryRevision === undefined) {
      await ctx.db.patch(user._id, { memberDirectoryRevision: 0 })
    }
  },
})

export const backfillWorkspaceMemberDirectory280826 = migrations.define({
  table: 'workspaceMembers',
  batchSize: 1,
  migrateOne: writeMemberDirectoryEntry,
})

export const backfillWorkspaceMemberSearchText290826 = migrations.define({
  table: 'workspaceMemberDirectory',
  batchSize: 100,
  migrateOne: async (ctx, member) => {
    const searchText = memberDirectorySearchText(member.normalizedName, member.normalizedEmail)
    if (member.searchText !== searchText) await ctx.db.patch(member._id, { searchText })
  },
})

export const backfillAuditSortId280826 = migrations.define({
  table: 'auditEvents',
  batchSize: 100,
  migrateOne: async (ctx, event) => {
    if ((event as { sortId?: string }).sortId === undefined) {
      await ctx.db.patch(event._id, { sortId: event._id })
    }
  },
})

export const backfillOauthGrantWorkspace280826 = migrations.define({
  table: 'oauthGrants',
  batchSize: 50,
  migrateOne: async (ctx, grant) => {
    const legacy = grant as typeof grant & { workspaceSlug?: string; workspaceName?: string }
    const patch: Partial<Doc<'oauthGrants'>> = {}
    if (legacy.workspaceSlug === undefined || legacy.workspaceName === undefined) {
      const workspace = await ctx.db.get(grant.workspaceId)
      if (workspace === null) throw new Error('OAuth grant workspace is missing')
      if (legacy.workspaceSlug === undefined) patch.workspaceSlug = workspace.slug
      if (legacy.workspaceName === undefined) patch.workspaceName = workspace.name
    }
    if (grant.paginationId !== grant._id) patch.paginationId = grant._id
    if (Object.keys(patch).length > 0) await ctx.db.patch(grant._id, patch)
  },
})

export const backfillApiKeyPagination280826 = migrations.define({
  table: 'apiKeys',
  batchSize: 100,
  migrateOne: async (ctx, key) => {
    if (key.paginationCreatedAt === key._creationTime && key.paginationId === key._id) return
    await ctx.db.patch(key._id, {
      paginationCreatedAt: key._creationTime,
      paginationId: key._id,
    })
  },
})

export const backfillWorkspaceInvitePagination280826 = migrations.define({
  table: 'workspaceInvites',
  batchSize: 100,
  migrateOne: async (ctx, invite) => {
    if (invite.paginationId !== invite._id) {
      await ctx.db.patch(invite._id, { paginationId: invite._id })
    }
  },
})

export const backfillShareDiscovery280826 = migrations.define({
  table: 'shares',
  batchSize: 50,
  migrateOne: async (ctx, share) => {
    if (share.paginationId !== share._id) {
      await ctx.db.patch(share._id, { paginationId: share._id })
    }
    await ensureWorkspaceShareDirectoryEntry(ctx, {
      workspaceId: share.fromWorkspaceId,
      shareId: share._id,
      direction: 'outgoing',
      createdAt: share.createdAt,
    })
    if (share.toWorkspaceId !== undefined) {
      await ensureWorkspaceShareDirectoryEntry(ctx, {
        workspaceId: share.toWorkspaceId,
        shareId: share._id,
        direction: 'incoming',
        createdAt: share.createdAt,
      })
    }
  },
})

export const backfillCreditPagination280826 = migrations.define({
  table: 'creditTransactions',
  batchSize: 50,
  migrateOne: async (ctx, transaction) => {
    const patch: Partial<Doc<'creditTransactions'>> = {}
    if (transaction.paginationId !== transaction._id) patch.paginationId = transaction._id
    if (transaction.workspaceName === undefined && transaction.workspaceId !== undefined) {
      const workspace = await ctx.db.get(transaction.workspaceId)
      if (workspace !== null) patch.workspaceName = workspace.name
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(transaction._id, patch)
  },
})

export function legacyFileEventIsRead(kind: Doc<'fileEvents'>['kind']): boolean {
  return kind === 'read' || kind === 'viewed-summary'
}

export const backfillFileEventReadKind280826 = migrations.define({
  table: 'fileEvents',
  batchSize: 100,
  migrateOne: async (ctx, event) => {
    if ((event as { isRead?: boolean }).isRead === undefined) {
      await ctx.db.patch(event._id, { isRead: legacyFileEventIsRead(event.kind) })
    }
  },
})

export const backfillFileAccessOrder280826 = migrations.define({
  table: 'fileAccess',
  batchSize: 100,
  migrateOne: async (ctx, access) => {
    if ((access as { seenByAt?: number }).seenByAt === undefined) {
      await ctx.db.patch(access._id, { seenByAt: -access.lastAt })
    }
  },
})

/**
 * Give legacy sessions their workspace-visible default and build the indexed
 * discovery projection required by list, search, and activity queries.
 */
export async function backfillSpecificPeopleSessionRow(
  ctx: MutationCtx,
  session: Doc<'agentSessions'>,
): Promise<void> {
  const patch = specificPeopleSessionMigrationPatch(session as { audienceKind?: string })
  if (patch !== undefined) {
    await patchSessionAndReconcileDiscovery(ctx, session, patch)
  } else {
    await reconcileSessionDiscovery(ctx, session)
  }
}

export function specificPeopleSessionMigrationPatch(session: {
  audienceKind?: string
}): { audienceKind: 'workspace' } | undefined {
  return session.audienceKind === undefined ? { audienceKind: 'workspace' } : undefined
}

export const backfillSpecificPeopleSessions280826 = migrations.define({
  table: 'agentSessions',
  // Discovery reconciliation reads every current membership lane. One session
  // per transaction keeps that bounded fanout independent of table size.
  batchSize: 1,
  migrateOne: backfillSpecificPeopleSessionRow,
})

// Archived rows born before `archived` counted as taking a slug can share it
// with a live workspace.
export const reslugArchivedWorkspaceCollisions050926 = migrations.define({
  table: 'workspaces',
  batchSize: 50,
  migrateOne: reslugArchivedWorkspaceCollision,
})

// Rows written before the transcript stamp existed answer the same predicate
// the writer now applies, so the transcript view pages every session's history.
export async function backfillTranscriptEventRow(
  ctx: MutationCtx,
  row: Doc<'agentSessionEvents'>,
): Promise<void> {
  if (row.transcript === undefined && isTranscriptEvent(row.event)) {
    await ctx.db.patch(row._id, { transcript: true })
  }
}

export const backfillTranscriptEventRows090926 = migrations.define({
  table: 'agentSessionEvents',
  batchSize: 200,
  migrateOne: backfillTranscriptEventRow,
})

export async function backfillInterruptedSessionBucketRow(
  ctx: MutationCtx,
  session: Doc<'agentSessions'>,
): Promise<void> {
  if (session.turnStatus !== 'interrupted') return
  const bucket = bucketOf(session)
  if (session.bucket !== bucket) {
    await patchSessionAndReconcileDiscovery(ctx, session, { bucket })
  } else {
    await reconcileSessionDiscovery(ctx, session)
  }
}

export const backfillInterruptedSessionBuckets260926 = migrations.define({
  table: 'agentSessions',
  // Discovery fans out across the bounded current workspace membership.
  batchSize: 1,
  migrateOne: backfillInterruptedSessionBucketRow,
})

export async function migrateHumanIdentityKeyRow(
  ctx: MutationCtx,
  key: Doc<'apiKeys'> & {
    scopes?: string[]
    workspaceIds?: Array<Id<'workspaces'>>
    workspaceId?: Id<'workspaces'>
  },
): Promise<void> {
  if (key.kind !== 'user') return
  if (key.scopes === undefined && key.workspaceIds === undefined && key.workspaceId === undefined)
    return
  await ctx.db.patch(key._id, {
    scopes: undefined,
    workspaceIds: undefined,
    workspaceId: undefined,
  })
}

export const migrateHumanIdentityKeys031026 = migrations.define({
  table: 'apiKeys',
  batchSize: 100,
  migrateOne: migrateHumanIdentityKeyRow,
})

export const expireLegacyDeviceCodes031026 = migrations.define({
  table: 'deviceCodes',
  batchSize: 100,
  migrateOne: async (
    ctx,
    code: Doc<'deviceCodes'> & {
      scopes?: string[]
      capabilities?: string[]
      workspaceIds?: Array<Id<'workspaces'>>
      deviceName?: string
    },
  ) => {
    if (
      code.scopes === undefined &&
      code.capabilities === undefined &&
      code.workspaceIds === undefined &&
      code.deviceName === undefined
    )
      return
    const patch = {
      status: 'expired' as const,
      expiresAt: Math.min(code.expiresAt, Date.now()),
      scopes: undefined,
      capabilities: undefined,
      workspaceIds: undefined,
      deviceName: undefined,
    }
    await ctx.db.patch(code._id, patch)
  },
})

export async function migrateWorkspaceRuntimeIdentityRow(
  ctx: MutationCtx,
  workspace: Doc<'workspaces'> & {
    gatewayVersion?: string
    agentVersion?: string
    duetfsVersion?: string
  },
): Promise<void> {
  if (
    workspace.gatewayVersion === undefined &&
    workspace.agentVersion === undefined &&
    workspace.duetfsVersion === undefined
  )
    return
  const patch = {
    runtimeVersion: workspace.runtimeVersion ?? workspace.gatewayVersion,
    gatewayVersion: undefined,
    agentVersion: undefined,
    duetfsVersion: undefined,
  }
  await ctx.db.patch(workspace._id, patch)
}

export const migrateWorkspaceRuntimeIdentity041026 = migrations.define({
  table: 'workspaces',
  batchSize: 100,
  migrateOne: migrateWorkspaceRuntimeIdentityRow,
})

export const run = migrations.runner([])
