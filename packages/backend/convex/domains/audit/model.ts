import {
  ANALYTICS_EXCLUDED_AUDIT_EVENT_NAMES,
  MAX_AUDIT_PROVENANCE_JSON_BYTES,
  type AuditEventName,
  type JsonObject,
  type JsonPrimitive,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { PRODUCT_BACKEND_ANALYTICS_ORIGIN, emitAnalyticsEvent } from '../analytics/model'
import { assertJsonStorageBound } from '../shared/jsonStorageBounds'

export { MAX_AUDIT_PROVENANCE_JSON_BYTES } from '@repo/contract'

export interface WriteAuditEventArgs {
  workspaceId: Id<'workspaces'>
  event: AuditEventName
  actorId: Id<'users'>
  provenance?: unknown
  at?: number
}

const excludedAnalyticsEvents = new Set<AuditEventName>(ANALYTICS_EXCLUDED_AUDIT_EVENT_NAMES)

const scalarProvenanceKeys = [
  'action',
  'activeAgentSessions',
  'activeTrainJobs',
  'actor',
  'acknowledged',
  'agentVersion',
  'anchorId',
  'appId',
  'appSlug',
  'agentId',
  'archiveStorageId',
  'lifecycleBackupId',
  'breaksPublicUrls',
  'canonicalEmail',
  'conflictingAnchorId',
  'conflictingPath',
  'confidence',
  'cpu',
  'deviceCode',
  'deviceId',
  'deviceName',
  'defaultModelId',
  'tier',
  'expiresAt',
  'fromPath',
  'fromWorkspaceId',
  'runtimeVersion',
  'gatewayVersion',
  'generation',
  'imageRef',
  'imageVersion',
  'inodeMatch',
  'installMode',
  'kind',
  'lastHeartbeatAt',
  'listingId',
  'listingSlug',
  'markerMatch',
  'memory',
  'memberUserId',
  'name',
  'newBillingUserId',
  'mode',
  'mountPath',
  'newSlug',
  'oldBillingUserId',
  'oldSlug',
  'parentShareId',
  'path',
  'prefix',
  'previousVmName',
  'publishId',
  'reason',
  'role',
  'oldRole',
  'shareId',
  'slug',
  'source',
  'subscriptionId',
  'targetEmail',
  'toPath',
  'toWorkspaceId',
  'visibility',
  'vmName',
] as const

const countedProvenanceArrays = {
  candidates: 'candidateCount',
  oldPrefixes: 'oldPrefixCount',
  prefixes: 'prefixCount',
  revokedShareIds: 'revokedShareCount',
  scopes: 'scopeCount',
} as const

export async function writeAuditEvent(
  ctx: MutationCtx,
  args: WriteAuditEventArgs,
): Promise<Id<'auditEvents'>> {
  const at = args.at ?? Date.now()
  assertAuditProvenanceBound(args.provenance)
  const auditEventId = await ctx.db.insert('auditEvents', {
    workspaceId: args.workspaceId,
    event: args.event,
    actorId: args.actorId,
    provenance: args.provenance as never,
    at,
    sortId: '',
  })
  await ctx.db.patch(auditEventId, { sortId: auditEventId })
  if (shouldEmitAuditAnalytics(args.event)) {
    await emitAnalyticsEvent(ctx, {
      id: auditEventId,
      name: args.event,
      version: 1,
      at,
      origin: PRODUCT_BACKEND_ANALYTICS_ORIGIN,
      userId: args.actorId,
      workspaceId: args.workspaceId,
      properties: projectAuditProperties(args.provenance),
    })
  }
  return auditEventId
}

export function assertAuditProvenanceBound(provenance: unknown): void {
  if (provenance === undefined) return
  assertJsonStorageBound(provenance, MAX_AUDIT_PROVENANCE_JSON_BYTES, 'Audit provenance')
}

export function shouldEmitAuditAnalytics(event: AuditEventName): boolean {
  return !excludedAnalyticsEvents.has(event)
}

export function projectAuditProperties(provenance: unknown): JsonObject {
  if (!isRecord(provenance)) return {}
  const properties: JsonObject = {}
  for (const key of scalarProvenanceKeys) {
    const value = provenance[key]
    if (isJsonPrimitive(value)) properties[key] = value
  }
  for (const [sourceKey, countKey] of Object.entries(countedProvenanceArrays)) {
    const value = provenance[sourceKey]
    if (Array.isArray(value)) properties[countKey] = value.length
  }
  return properties
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}
