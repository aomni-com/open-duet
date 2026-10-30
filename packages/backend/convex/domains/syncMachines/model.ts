import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { ConvexError } from 'convex/values'

import { MAX_SYNC_MACHINES_PER_USER, WORKSPACE_MEMBER_LIMIT } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { liveWorkspaceMemberships, roleCanGrant } from '../apiKeys/model'

type Reader = GenericQueryCtx<DataModel>
type Writer = GenericMutationCtx<DataModel>

function project(machine: Doc<'syncMachines'>) {
  return {
    machineId: machine._id,
    name: machine.name,
    syncthingDeviceId: machine.syncthingDeviceId,
    createdAt: machine.createdAt,
    lastUsedAt: machine.lastUsedAt,
    ...(machine.removedAt === undefined ? {} : { removedAt: machine.removedAt }),
  }
}

export async function registerMachine(
  ctx: Writer,
  args: {
    actorId: Id<'users'>
    name: string
    syncthingDeviceId: string
    now: number
  },
) {
  const existing = await ctx.db
    .query('syncMachines')
    .withIndex('by_user_peer', q =>
      q.eq('userId', args.actorId).eq('syncthingDeviceId', args.syncthingDeviceId),
    )
    .unique()
  if (existing !== null) {
    if (
      existing.removedAt !== undefined &&
      (await machineIdsForUser(ctx, args.actorId)).length >= MAX_SYNC_MACHINES_PER_USER
    ) {
      throw new ConvexError({ code: 'sync_machine_limit', message: 'Sync machine limit reached' })
    }
    await ctx.db.patch(existing._id, {
      name: args.name.trim(),
      lastUsedAt: args.now,
      removedAt: undefined,
    })
    return project({
      ...existing,
      name: args.name.trim(),
      lastUsedAt: args.now,
      removedAt: undefined,
    })
  }
  if ((await machineIdsForUser(ctx, args.actorId)).length >= MAX_SYNC_MACHINES_PER_USER) {
    throw new ConvexError({ code: 'sync_machine_limit', message: 'Sync machine limit reached' })
  }
  const id = await ctx.db.insert('syncMachines', {
    userId: args.actorId,
    name: args.name.trim(),
    syncthingDeviceId: args.syncthingDeviceId,
    createdAt: args.now,
    lastUsedAt: args.now,
  })
  return project((await ctx.db.get(id))!)
}

export async function listMachines(
  ctx: Reader,
  actorId: Id<'users'>,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  const page = await ctx.db
    .query('syncMachines')
    .withIndex('by_user_created', q => q.eq('userId', actorId))
    .order('desc')
    .paginate(paginationOpts)
  return { ...page, page: page.page.map(project) }
}

export async function machineOwnedByUser(
  ctx: Reader,
  args: { actorId: Id<'users'>; machineId: Id<'syncMachines'>; syncthingDeviceId?: string },
) {
  const machine = await ctx.db.get(args.machineId)
  return (
    machine !== null &&
    machine.userId === args.actorId &&
    machine.removedAt === undefined &&
    (args.syncthingDeviceId === undefined || args.syncthingDeviceId === machine.syncthingDeviceId)
  )
}

export async function useMachine(
  ctx: Writer,
  args: {
    actorId: Id<'users'>
    machineId: Id<'syncMachines'>
    syncthingDeviceId: string
    workspaceId: Id<'workspaces'>
    now: number
  },
) {
  const member = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q =>
      q.eq('workspaceId', args.workspaceId).eq('userId', args.actorId),
    )
    .unique()
  if (member === null || !roleCanGrant(member.role, 'files:write'))
    throw new ConvexError({
      code: 'workspace_write_access_required',
      message: 'Workspace write access required',
    })
  if (!(await machineOwnedByUser(ctx, args)))
    throw new ConvexError({ code: 'sync_machine_not_found', message: 'Sync machine not found' })
  const machine = (await ctx.db.get(args.machineId))!
  await ctx.db.patch(machine._id, { lastUsedAt: args.now })
  return project({ ...machine, lastUsedAt: args.now })
}

export async function machineIdsForUser(ctx: Reader, actorId: Id<'users'>) {
  const machines = await ctx.db
    .query('syncMachines')
    .withIndex('by_user_removed', q => q.eq('userId', actorId).eq('removedAt', undefined))
    .take(MAX_SYNC_MACHINES_PER_USER)
  return machines.map(machine => machine._id)
}

export async function removeMachine(
  ctx: Writer,
  args: { actorId: Id<'users'>; machineId: Id<'syncMachines'>; now: number },
) {
  const machine = await ctx.db.get(args.machineId)
  if (machine === null || machine.userId !== args.actorId)
    throw new ConvexError({ code: 'sync_machine_not_found', message: 'Sync machine not found' })
  const workspaceSlugs = (await liveWorkspaceMemberships(ctx, args.actorId)).map(
    ({ workspace }) => workspace.slug,
  )
  const removedAt = machine.removedAt ?? args.now
  if (machine.removedAt === undefined) await ctx.db.patch(machine._id, { removedAt })
  return { ok: true as const, machineId: machine._id, removedAt, workspaceSlugs }
}

export async function mirrorMachineIdsForWorkspace(ctx: Reader, workspaceId: Id<'workspaces'>) {
  const members = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId))
    .take(WORKSPACE_MEMBER_LIMIT)
  const ids = await Promise.all(
    members
      .filter(member => roleCanGrant(member.role, 'files:write'))
      .map(member => machineIdsForUser(ctx, member.userId)),
  )
  return ids.flat()
}
