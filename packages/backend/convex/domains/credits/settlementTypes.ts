import { v } from 'convex/values'

export const serviceChargeMetadataValidator = v.object({
  service: v.string(),
  path: v.string(),
  method: v.string(),
  routeId: v.optional(v.string()),
  vendorCostMicroUsd: v.optional(v.number()),
})

export const settlementOperationValidator = v.union(
  v.object({
    kind: v.literal('service'),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    amountMicroUsd: v.number(),
    reference: v.string(),
    metadata: serviceChargeMetadataValidator,
    occurredAt: v.number(),
  }),
  v.object({
    kind: v.literal('generation'),
    generationId: v.id('gatewayGenerations'),
    occurredAt: v.number(),
  }),
)
