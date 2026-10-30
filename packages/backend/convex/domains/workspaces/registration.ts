import type { Infer } from 'convex/values'

import {
  type VmRestoreReference,
  VmProviderHttpsUrlSchema,
  VmProviderNameSchema,
  VmProviderSshDestSchema,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { hashSecret, requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { grantTrialCreditsForAccount } from '../credits/grants'
import type { registerVmArgs } from './provisioning'
import { auditActor } from './provisioningShared'
import { resolveRegistrationRestore } from './seed'
import { composeVmModelCredentials, reportedVersionPatch } from './vmSync'
import { deriveVmToken, randomHex, VM_TOKEN_PREFIX } from './vmToken'

export async function registerVmImpl(
  ctx: MutationCtx,
  args: Infer<typeof registerVmArgs>,
): Promise<{
  workspaceId: Id<'workspaces'>
  workspaceSlug: string
  vmToken: string
  vmTokenPrefix: string
  restore: VmRestoreReference | null
  modelCredentials?: { apiKey: string; expiresAt: number }
}> {
  requireApiInternalKey(args.internalKey)
  const workspaceId = ctx.db.normalizeId('workspaces', args.workspaceHint)
  if (workspaceId === null) throw new Error(`Workspace not found: ${args.workspaceHint}`)
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error(`Workspace not found: ${workspaceId}`)
  // Every refusal names the workspace. A refused VM has no VM token, so its
  // sync loop re-registers on every backoff tick — every five minutes, forever,
  // or until teardown reaps it — and this message is the only clue to which one.
  const refuse = (reason: string): never => {
    throw new Error(
      `${reason} (workspace ${workspaceId}, vm ${workspace.vmName ?? 'unnamed'}, status ${workspace.status})`,
    )
  }
  if (workspace.provisioningTokenHash !== args.provisioningTokenHash)
    refuse('Invalid provisioning token')
  const replay = isRegistrationReplay(workspace)
  if (!replay) {
    if (workspace.provisioningTokenUsedAt !== undefined) refuse('Provisioning token already used')
    if (workspace.status !== 'provisioning') refuse(`Workspace is ${workspace.status}`)
    if (
      workspace.provisioningTokenExpiresAt === undefined ||
      workspace.provisioningTokenExpiresAt <= args.now
    ) {
      refuse('Provisioning token expired')
    }
  }
  const vmTokenNonce = workspace.vmTokenNonce ?? randomHex(16)
  const vmToken = await deriveVmToken(workspaceId, vmTokenNonce)
  const vmTokenHash = await hashSecret(vmToken)
  const vmTokenPrefix = vmToken.slice(0, VM_TOKEN_PREFIX.length + 8)
  const vmName = optionalParse(VmProviderNameSchema, args.vmName ?? workspace.vmName)
  const sshDest = optionalParse(VmProviderSshDestSchema, args.sshDest ?? workspace.sshDest)
  const httpsUrl = optionalParse(VmProviderHttpsUrlSchema, args.httpsUrl ?? workspace.httpsUrl)
  await ctx.db.patch(workspaceId, {
    status: 'active',
    updatedAt: args.now,
    // The token hash stays on the row: it is what lets the same VM replay this
    // registration if the response never reaches it (see isRegistrationReplay).
    provisioningTokenUsedAt: args.now,
    provisioningTokenExpiresAt: undefined,
    vmCleanupPending: true,
    vmTokenNonce,
    vmTokenHash,
    vmName,
    sshDest,
    httpsUrl,
    ...reportedVersionPatch(args),
    lastHeartbeatAt: args.now,
    healthSweepRetryAt: undefined,
    vmModelCredentialRetryAt: undefined,
    vmModelCredentialRetryScopeKey: undefined,
  })
  await writeAuditEvent(ctx, {
    workspaceId,
    event: replay ? 'workspace.vm_reregistered' : 'workspace.vm_registered',
    actorId: auditActor(workspace),
    at: args.now,
    provenance: {
      vmName,
      runtimeVersion: args.runtimeVersion,
      imageVersion: args.imageVersion,
      ...(replay ? { previousStatus: workspace.status } : {}),
    },
  })
  if (!replay) {
    await grantTrialCreditsForAccount(ctx, {
      workspaceId,
      actorId: auditActor(workspace),
      now: args.now,
      source: 'vm_register',
    })
  }
  const restore = await resolveRegistrationRestore(ctx, workspace)
  if (restore?.kind === 'birth-seed') {
    // Stamped with this registration's clock so the authenticated download
    // recognizes it as the delivery this very token performed.
    await ctx.db.patch(workspaceId, { birthSeedDeliveredAt: args.now })
  }
  const modelCredentials =
    args.deliverModelCredentials === true &&
    (workspace.servicingStatus === undefined || workspace.servicingStatus === 'active')
      ? await composeVmModelCredentials(ctx, {
          workspaceId,
          now: args.now,
          // A replay's first key never reached the VM; supersede it rather
          // than hand back nothing.
          mode: replay ? 'mint-or-supersede' : 'mint',
        })
      : undefined
  return {
    workspaceId,
    workspaceSlug: workspace.slug,
    vmToken,
    vmTokenPrefix,
    restore,
    ...(modelCredentials === undefined ? {} : { modelCredentials }),
  }
}

/**
 * A registration this token already performed, whose response may never have
 * reached the VM. The VM holds nothing but its provisioning token, so a
 * strictly single-use token bricks the workspace the moment the API commits and
 * then fails to answer (2026-08-29: a deploy-window contract skew answered two
 * committed registrations with 401; both VMs then re-registered every five
 * minutes for days). The door stays open only until the VM's first sync — that
 * is the proof the token landed — and a health sweep flipping the silent row to
 * `unhealthy` in the meantime does not close it.
 */
function isRegistrationReplay(workspace: Doc<'workspaces'>): boolean {
  return (
    (workspace.status === 'active' || workspace.status === 'unhealthy') &&
    workspace.provisioningTokenUsedAt !== undefined &&
    workspace.lastHeartbeatAt === workspace.provisioningTokenUsedAt
  )
}

function optionalParse<T>(schema: { parse(value: unknown): T }, value: unknown): T | undefined {
  return value === undefined ? undefined : schema.parse(value)
}
