import { v } from 'convex/values'

export const domainStatusValidator = v.union(
  v.literal('pending'),
  v.literal('verifying'),
  v.literal('active'),
  v.literal('failed'),
  v.literal('removing'),
)
export const domainTargetValidator = v.object({
  teamId: v.string(),
  projectId: v.string(),
  gitBranch: v.union(v.string(), v.null()),
})
export const dnsRecordValidator = v.object({
  type: v.string(),
  domain: v.string(),
  value: v.string(),
  reason: v.optional(v.string()),
})
export const dnsConflictValidator = v.object({
  name: v.string(),
  type: v.string(),
  value: v.string(),
})
export const domainOperationValidator = v.union(
  v.literal('add'),
  v.literal('check'),
  v.literal('remove'),
)
