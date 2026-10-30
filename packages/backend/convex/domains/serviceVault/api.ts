import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'

// HTTP-facing adapters for the API service. The model functions stay
// internal so only these deliberately narrow entry points are public in the
// Convex function registry. Each adapter delegates to a model function that
// validates DUET_API_INTERNAL_KEY before touching the vault or pool tables.

const credentialArgs = {
  internalKey: v.string(),
  serviceId: v.string(),
  name: v.string(),
}

const getServiceCredentialRef = makeFunctionReference<'query'>('domains/serviceVault/model:getServiceCredential')
const poolOwnerRef = makeFunctionReference<'query'>('domains/serviceVault/model:poolOwner')
const recordPoolResourceRef = makeFunctionReference<'mutation'>('domains/serviceVault/model:recordPoolResource')
const markPoolResourceDeletedRef = makeFunctionReference<'mutation'>('domains/serviceVault/model:markPoolResourceDeleted')

export const getServiceCredential = query({
  args: credentialArgs,
  handler: async (ctx, args) =>
    await ctx.runQuery(getServiceCredentialRef, args),
})

export const poolOwner = query({
  args: {
    internalKey: v.string(),
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
  },
  handler: async (ctx, args) =>
    await ctx.runQuery(poolOwnerRef, args),
})

export const recordPoolResource = mutation({
  args: {
    internalKey: v.string(),
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
    workspaceId: v.id('workspaces'),
    createdAt: v.number(),
    expiresAt: v.number(),
    expiry: v.optional(v.object({
      baseUrl: v.string(),
      method: v.string(),
      path: v.string(),
      body: v.optional(v.any()),
      authKind: v.string(),
      authName: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) =>
    await ctx.runMutation(recordPoolResourceRef, args),
})

export const markPoolResourceDeleted = mutation({
  args: {
    internalKey: v.string(),
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
  },
  handler: async (ctx, args) =>
    await ctx.runMutation(markPoolResourceDeletedRef, args),
})
