import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  registerMachine,
  listMachines,
  removeMachine,
  useMachine,
  machineOwnedByUser,
  machineIdsForUser,
} from './model'

export const register = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    name: v.string(),
    syncthingDeviceId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return registerMachine(ctx, args)
  },
})
export const list = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return listMachines(ctx, args.actorId, args.paginationOpts)
  },
})
export const remove = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    machineId: v.id('syncMachines'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return removeMachine(ctx, args)
  },
})
export const use = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    machineId: v.id('syncMachines'),
    syncthingDeviceId: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return useMachine(ctx, args)
  },
})
export const owned = query({
  args: { internalKey: v.string(), actorId: v.id('users'), machineId: v.id('syncMachines') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return machineOwnedByUser(ctx, args)
  },
})
export const idsForUser = query({
  args: { internalKey: v.string(), actorId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return machineIdsForUser(ctx, args.actorId)
  },
})
