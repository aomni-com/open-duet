import type { Id } from '../../_generated/dataModel'

export function auditActor(workspace: { createdByUserId?: Id<'users'> }): Id<'users'> {
  if (workspace.createdByUserId === undefined) throw new Error('Workspace missing createdByUserId')
  return workspace.createdByUserId
}
