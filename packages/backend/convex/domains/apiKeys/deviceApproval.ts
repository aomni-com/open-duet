import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { DeviceApprovalResponse } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { liveWorkspaceMemberships, normalizeUserCode, writeAuditForWorkspaceIds } from './model'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type ApprovalArgs = { actorId: Id<'users'>; userCode: string; now: number }

export async function inspectDeviceApproval(
  ctx: QueryCtx | MutationCtx,
  args: ApprovalArgs,
): Promise<DeviceApprovalResponse> {
  return approvalResponse(await requireDeviceCode(ctx, args.userCode), args.now)
}
export async function approveDeviceApproval(
  ctx: MutationCtx,
  args: ApprovalArgs,
): Promise<DeviceApprovalResponse> {
  return await decideDeviceApproval(ctx, args, 'approved')
}
export async function denyDeviceApproval(
  ctx: MutationCtx,
  args: ApprovalArgs,
): Promise<DeviceApprovalResponse> {
  return await decideDeviceApproval(ctx, args, 'denied')
}
async function decideDeviceApproval(
  ctx: MutationCtx,
  args: ApprovalArgs,
  status: 'approved' | 'denied',
): Promise<DeviceApprovalResponse> {
  const code = await requireDeviceCode(ctx, args.userCode)
  const effective = effectiveDeviceCodeStatus(code, args.now)
  if (effective === 'expired') throw new Error('Device code expired')
  if (effective !== 'pending') throw new Error(`Device code is ${effective}`)
  await ctx.db.patch(code._id, { status, userId: args.actorId })
  await writeAuditForWorkspaceIds(ctx, {
    workspaceIds: (await liveWorkspaceMemberships(ctx, args.actorId)).map(
      ({ workspace }) => workspace._id,
    ),
    event: status === 'approved' ? 'device_code.approved' : 'device_code.denied',
    actorId: args.actorId,
    provenance: { userCode: code.userCode },
    at: args.now,
  })
  return approvalResponse({ ...code, status }, args.now)
}
async function requireDeviceCode(
  ctx: QueryCtx | MutationCtx,
  userCode: string,
): Promise<Doc<'deviceCodes'>> {
  const code = await ctx.db
    .query('deviceCodes')
    .withIndex('by_userCode', q => q.eq('userCode', normalizeUserCode(userCode)))
    .first()
  if (code === null) throw new Error('Device code not found')
  return code
}
function approvalResponse(code: Doc<'deviceCodes'>, now: number): DeviceApprovalResponse {
  return {
    userCode: code.userCode,
    status: effectiveDeviceCodeStatus(code, now),
    expiresAt: code.expiresAt,
    ...(code.clientName === undefined ? {} : { clientName: code.clientName }),
  }
}
export function effectiveDeviceCodeStatus(
  code: Pick<Doc<'deviceCodes'>, 'expiresAt' | 'status'>,
  now: number,
): DeviceApprovalResponse['status'] {
  if (code.status !== 'consumed' && code.expiresAt <= now) return 'expired'
  return code.status
}
