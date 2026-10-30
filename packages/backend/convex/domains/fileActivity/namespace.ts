import { FileEventBatchSchema, type DriveFileEvent } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'

type NamespaceDb = MutationCtx['db'] | QueryCtx['db']
type EntryKind = 'file' | 'folder'

export interface NamespaceOperationCounts {
  bindingReads: number
  bindingWrites: number
  entityWrites: number
}

export interface NamespaceBindingChange {
  bindingId: Id<'fileActivityBindings'>
  state: 'active' | 'ended'
}

export interface NamespaceTransition {
  sequence: number
  entityId: Id<'fileActivityEntities'> | null
  bindingChanges: NamespaceBindingChange[]
  lineageMiss: boolean
}

export interface NamespaceBatchResult {
  transitions: NamespaceTransition[]
  operations: NamespaceOperationCounts
}

export interface NamespaceResolution {
  entityId: Id<'fileActivityEntities'>
  epoch: number
  historical: boolean
  bindingReads: number
}

interface NamespaceState {
  namespace: Doc<'fileActivityNamespaces'>
  operations: NamespaceOperationCounts
}

export async function applyNamespaceEvents(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    firstSequence?: number
    events: readonly DriveFileEvent[]
  },
): Promise<NamespaceBatchResult> {
  // Validate the complete input before the first write. Convex also rolls the
  // mutation back on errors, but preflight keeps rejection independent of that.
  const events = FileEventBatchSchema.parse({
    batchId: 'namespace-transition',
    events: args.events,
    droppedReads: 0,
    overflow: 0,
  }).events
  const state: NamespaceState = {
    namespace: await ensureNamespace(ctx, args.workspaceId),
    operations: { bindingReads: 0, bindingWrites: 0, entityWrites: 0 },
  }
  const firstSequence = args.firstSequence ?? state.namespace.nextSequence
  if (firstSequence !== state.namespace.nextSequence) {
    throw new Error(`firstSequence must equal the namespace's next sequence`)
  }
  if (firstSequence + events.length - 1 > Number.MAX_SAFE_INTEGER) {
    throw new Error('namespace sequence exceeds safe integer range')
  }
  const transitions: NamespaceTransition[] = []
  for (const [index, event] of events.entries()) {
    transitions.push(await applyEvent(ctx, state, firstSequence + index, event))
  }
  if (events.length > 0) {
    await ctx.db.patch(state.namespace._id, { nextSequence: firstSequence + events.length })
  }
  return { transitions, operations: state.operations }
}

export async function resolveNamespacePath(
  db: NamespaceDb,
  workspaceId: Id<'workspaces'>,
  path: string,
  mode: 'current' | 'selectable',
): Promise<NamespaceResolution | null> {
  const namespace = await db
    .query('fileActivityNamespaces')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .unique()
  if (namespace === null) return null
  let parentEntityId = namespace.rootEntityId
  let historical = false
  let bindingReads = 0
  for (const name of pathSegments(path)) {
    const active = await activeBinding(
      db,
      workspaceId,
      namespace.currentEpoch,
      parentEntityId,
      name,
    )
    bindingReads += 1
    let binding = active
    if (binding === null && mode === 'selectable') {
      bindingReads += 1
      binding = await newestEndedBinding(
        db,
        workspaceId,
        namespace.currentEpoch,
        parentEntityId,
        name,
      )
    }
    if (binding === null) return null
    historical ||= binding.state === 'ended'
    parentEntityId = binding.childEntityId
  }
  return { entityId: parentEntityId, epoch: namespace.currentEpoch, historical, bindingReads }
}

export async function resolveNamespaceChildren(
  db: NamespaceDb,
  workspaceId: Id<'workspaces'>,
  parentEntityId: Id<'fileActivityEntities'>,
  names: readonly string[],
): Promise<Map<string, Id<'fileActivityEntities'>>> {
  const namespace = await db
    .query('fileActivityNamespaces')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .unique()
  const children = new Map<string, Id<'fileActivityEntities'>>()
  if (namespace === null) return children
  for (const name of names) {
    const binding = await activeBinding(
      db,
      workspaceId,
      namespace.currentEpoch,
      parentEntityId,
      name,
    )
    if (binding !== null) children.set(name, binding.childEntityId)
  }
  return children
}

async function ensureNamespace(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<Doc<'fileActivityNamespaces'>> {
  const existing = await ctx.db
    .query('fileActivityNamespaces')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .unique()
  if (existing !== null) return existing
  const rootEntityId = await ctx.db.insert('fileActivityEntities', {
    workspaceId,
    epoch: 1,
    kind: 'folder',
    createdSequence: 0,
  })
  const namespaceId = await ctx.db.insert('fileActivityNamespaces', {
    workspaceId,
    currentEpoch: 1,
    rootEntityId,
    lineageMisses: 0,
    nextSequence: 1,
  })
  await ctx.db.insert('fileEventProjectionState', { workspaceId, completedSeq: 0 })
  const namespace = await ctx.db.get(namespaceId)
  if (namespace === null) throw new Error('namespace initialization failed')
  return namespace
}

async function applyEvent(
  ctx: MutationCtx,
  state: NamespaceState,
  sequence: number,
  event: DriveFileEvent,
): Promise<NamespaceTransition> {
  const bindingChanges: NamespaceBindingChange[] = []
  if (event.kind === 'restore') {
    await ctx.db.patch(state.namespace.rootEntityId, { retiredSequence: sequence })
    state.operations.entityWrites += 1
    const epoch = state.namespace.currentEpoch + 1
    const rootEntityId = await ctx.db.insert('fileActivityEntities', {
      workspaceId: state.namespace.workspaceId,
      epoch,
      kind: 'folder',
      createdSequence: sequence,
    })
    state.operations.entityWrites += 1
    await ctx.db.patch(state.namespace._id, { currentEpoch: epoch, rootEntityId })
    state.namespace = { ...state.namespace, currentEpoch: epoch, rootEntityId }
    return { sequence, entityId: null, bindingChanges, lineageMiss: false }
  }

  if (event.kind === 'rename') {
    if (
      event.entryKind === 'folder' &&
      (event.path === event.fromPath || event.path.startsWith(`${event.fromPath}/`))
    ) {
      throw new Error('cannot rename a folder into itself or its descendant')
    }
    const source = await resolveCurrent(ctx.db, state, event.fromPath)
    const destination = await resolveParent(ctx, state, event.path, sequence, bindingChanges)
    await retireActiveSlot(
      ctx,
      state,
      destination.parentEntityId,
      destination.name,
      sequence,
      bindingChanges,
    )
    let entityId: Id<'fileActivityEntities'>
    let lineageMiss = false
    if (source === null) {
      entityId = await mintEntity(ctx, state, event.entryKind, sequence)
      lineageMiss = true
      await ctx.db.patch(state.namespace._id, {
        lineageMisses: state.namespace.lineageMisses + 1,
      })
      state.namespace = { ...state.namespace, lineageMisses: state.namespace.lineageMisses + 1 }
    } else {
      entityId = source.entityId
      await endBinding(ctx, state, source.binding, sequence, bindingChanges)
    }
    await openBinding(
      ctx,
      state,
      destination.parentEntityId,
      destination.name,
      entityId,
      sequence,
      bindingChanges,
    )
    return { sequence, entityId, bindingChanges, lineageMiss }
  }

  const expectedKind: EntryKind =
    event.kind === 'changed-summary' || event.kind === 'viewed-summary'
      ? 'folder'
      : event.kind === 'create' || event.kind === 'delete'
        ? event.entryKind
        : 'file'
  if (
    event.kind === 'write' ||
    event.kind === 'read' ||
    event.kind === 'changed-summary' ||
    event.kind === 'viewed-summary'
  ) {
    const current = await resolveCurrent(ctx.db, state, event.path)
    if (current !== null) {
      if (expectedKind === 'file' || (await ctx.db.get(current.entityId))?.kind === 'folder') {
        return { sequence, entityId: current.entityId, bindingChanges, lineageMiss: false }
      }
    }
  }

  const destination = await resolveParent(ctx, state, event.path, sequence, bindingChanges)
  if (event.kind === 'delete') {
    const active = await lookupActive(ctx.db, state, destination.parentEntityId, destination.name)
    if (active !== null) {
      await endBinding(ctx, state, active, sequence, bindingChanges)
      await retireEntity(ctx, state, active.childEntityId, sequence)
      return {
        sequence,
        entityId: active.childEntityId,
        bindingChanges,
        lineageMiss: false,
      }
    }
    const entityId = await mintEntity(ctx, state, expectedKind, sequence, sequence)
    const binding = await openBinding(
      ctx,
      state,
      destination.parentEntityId,
      destination.name,
      entityId,
      sequence,
      bindingChanges,
    )
    await endBinding(ctx, state, binding, sequence, bindingChanges)
    return { sequence, entityId, bindingChanges, lineageMiss: false }
  }

  await retireActiveSlot(
    ctx,
    state,
    destination.parentEntityId,
    destination.name,
    sequence,
    bindingChanges,
  )
  const entityId = await mintEntity(ctx, state, expectedKind, sequence)
  await openBinding(
    ctx,
    state,
    destination.parentEntityId,
    destination.name,
    entityId,
    sequence,
    bindingChanges,
  )
  return { sequence, entityId, bindingChanges, lineageMiss: false }
}

async function resolveCurrent(
  db: NamespaceDb,
  state: NamespaceState,
  path: string,
): Promise<{ entityId: Id<'fileActivityEntities'>; binding: Doc<'fileActivityBindings'> } | null> {
  let parentEntityId = state.namespace.rootEntityId
  let binding: Doc<'fileActivityBindings'> | null = null
  for (const name of pathSegments(path)) {
    binding = await lookupActive(db, state, parentEntityId, name)
    if (binding === null) return null
    parentEntityId = binding.childEntityId
  }
  return binding === null ? null : { entityId: parentEntityId, binding }
}

async function resolveParent(
  ctx: MutationCtx,
  state: NamespaceState,
  path: string,
  sequence: number,
  changes: NamespaceBindingChange[],
): Promise<{ parentEntityId: Id<'fileActivityEntities'>; name: string }> {
  const segments = pathSegments(path)
  const name = segments.pop()
  if (name === undefined) throw new Error('file activity path must name an entry')
  let parentEntityId = state.namespace.rootEntityId
  for (const segment of segments) {
    let binding = await lookupActive(ctx.db, state, parentEntityId, segment)
    if (binding !== null) {
      const entity = await ctx.db.get(binding.childEntityId)
      if (entity?.kind === 'folder') {
        parentEntityId = binding.childEntityId
        continue
      }
      await endBinding(ctx, state, binding, sequence, changes)
      if (entity !== null) await retireEntity(ctx, state, entity._id, sequence)
    }
    const folderId = await mintEntity(ctx, state, 'folder', sequence)
    binding = await openBinding(ctx, state, parentEntityId, segment, folderId, sequence, changes)
    parentEntityId = folderId
  }
  return { parentEntityId, name }
}

async function lookupActive(
  db: NamespaceDb,
  state: NamespaceState,
  parentEntityId: Id<'fileActivityEntities'>,
  name: string,
): Promise<Doc<'fileActivityBindings'> | null> {
  state.operations.bindingReads += 1
  return await activeBinding(
    db,
    state.namespace.workspaceId,
    state.namespace.currentEpoch,
    parentEntityId,
    name,
  )
}

async function activeBinding(
  db: NamespaceDb,
  workspaceId: Id<'workspaces'>,
  epoch: number,
  parentEntityId: Id<'fileActivityEntities'>,
  name: string,
): Promise<Doc<'fileActivityBindings'> | null> {
  return await db
    .query('fileActivityBindings')
    .withIndex('by_active_slot', q =>
      q
        .eq('workspaceId', workspaceId)
        .eq('epoch', epoch)
        .eq('parentEntityId', parentEntityId)
        .eq('activeName', name),
    )
    .unique()
}

async function newestEndedBinding(
  db: NamespaceDb,
  workspaceId: Id<'workspaces'>,
  epoch: number,
  parentEntityId: Id<'fileActivityEntities'>,
  name: string,
): Promise<Doc<'fileActivityBindings'> | null> {
  return await db
    .query('fileActivityBindings')
    .withIndex('by_ended_slot', q =>
      q
        .eq('workspaceId', workspaceId)
        .eq('epoch', epoch)
        .eq('parentEntityId', parentEntityId)
        .eq('endedName', name),
    )
    .order('desc')
    .first()
}

async function openBinding(
  ctx: MutationCtx,
  state: NamespaceState,
  parentEntityId: Id<'fileActivityEntities'>,
  name: string,
  childEntityId: Id<'fileActivityEntities'>,
  sequence: number,
  changes: NamespaceBindingChange[],
): Promise<Doc<'fileActivityBindings'>> {
  const bindingId = await ctx.db.insert('fileActivityBindings', {
    workspaceId: state.namespace.workspaceId,
    epoch: state.namespace.currentEpoch,
    parentEntityId,
    name,
    childEntityId,
    startSequence: sequence,
    state: 'active',
    activeName: name,
  })
  state.operations.bindingWrites += 1
  changes.push({ bindingId, state: 'active' })
  const binding = await ctx.db.get(bindingId)
  if (binding === null) throw new Error('binding insert failed')
  return binding
}

async function endBinding(
  ctx: MutationCtx,
  state: NamespaceState,
  binding: Doc<'fileActivityBindings'>,
  sequence: number,
  changes: NamespaceBindingChange[],
): Promise<void> {
  if (binding.state === 'ended') return
  await ctx.db.patch(binding._id, {
    state: 'ended',
    activeName: undefined,
    endedName: binding.name,
    endSequence: sequence,
  })
  state.operations.bindingWrites += 1
  changes.push({ bindingId: binding._id, state: 'ended' })
}

async function retireActiveSlot(
  ctx: MutationCtx,
  state: NamespaceState,
  parentEntityId: Id<'fileActivityEntities'>,
  name: string,
  sequence: number,
  changes: NamespaceBindingChange[],
): Promise<void> {
  const existing = await lookupActive(ctx.db, state, parentEntityId, name)
  if (existing === null) return
  await endBinding(ctx, state, existing, sequence, changes)
  await retireEntity(ctx, state, existing.childEntityId, sequence)
}

async function mintEntity(
  ctx: MutationCtx,
  state: NamespaceState,
  kind: EntryKind,
  createdSequence: number,
  retiredSequence?: number,
): Promise<Id<'fileActivityEntities'>> {
  const entityId = await ctx.db.insert('fileActivityEntities', {
    workspaceId: state.namespace.workspaceId,
    epoch: state.namespace.currentEpoch,
    kind,
    createdSequence,
    ...(retiredSequence === undefined ? {} : { retiredSequence }),
  })
  state.operations.entityWrites += 1
  return entityId
}

async function retireEntity(
  ctx: MutationCtx,
  state: NamespaceState,
  entityId: Id<'fileActivityEntities'>,
  sequence: number,
): Promise<void> {
  await ctx.db.patch(entityId, { retiredSequence: sequence })
  state.operations.entityWrites += 1
}

function pathSegments(path: string): string[] {
  return path === '' ? [] : path.split('/')
}

/**
 * The one owner of "which folder held this entity at this point in history".
 * Bindings are the namespace's business, so both readers live here: the
 * projector walking a full ancestor chain, and ingest resolving a single fold
 * target. `exclusive` selects the binding strictly before the sequence, which
 * is what a rename's old-path phase needs.
 */
export async function parentEntityAt(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    childEntityId: Id<'fileActivityEntities'>
    atSequence: number
    exclusive?: boolean
  },
): Promise<Id<'fileActivityEntities'> | null> {
  const entity = await ctx.db.get(args.childEntityId)
  if (entity === null) return null
  const binding = await ctx.db
    .query('fileActivityBindings')
    .withIndex('by_child_start', q => {
      const bindings = q
        .eq('workspaceId', args.workspaceId)
        .eq('epoch', entity.epoch)
        .eq('childEntityId', args.childEntityId)
      return args.exclusive === true
        ? bindings.lt('startSequence', args.atSequence)
        : bindings.lte('startSequence', args.atSequence)
    })
    .order('desc')
    .first()
  if (binding === null) return null
  if (binding.endSequence !== undefined && binding.endSequence < args.atSequence) return null
  return binding.parentEntityId
}
