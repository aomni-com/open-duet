import {
  ModelSelectionIdSchema,
  defaultTierFor,
  type ModelSelectionId,
  type TierEntitlement,
} from '@repo/contract'

export function resolveSessionTier(
  args: TierEntitlement & {
    requested?: string
    sessionLast?: string
    workspaceDefault?: string
  },
): ModelSelectionId {
  const requested = ModelSelectionIdSchema.safeParse(args.requested)
  const sessionLast = ModelSelectionIdSchema.safeParse(args.sessionLast)
  const workspaceDefault = ModelSelectionIdSchema.safeParse(args.workspaceDefault)
  // An invalid requested tier restarts at the workspace default rather than
  // inheriting the session's last tier.
  if (args.requested !== undefined && requested.success) return requested.data
  if (args.requested === undefined && sessionLast.success) return sessionLast.data
  return workspaceDefault.success ? workspaceDefault.data : defaultTierFor(args)
}
