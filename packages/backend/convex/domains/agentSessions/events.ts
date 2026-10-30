import { makeFunctionReference, type FunctionReference } from 'convex/server'
import type { Infer } from 'convex/values'

import {
  AgentStateMachineSessionSchema,
  AgentTurnEventSchema,
  bucketOf,
  classifyAgentTurnEvent,
  projectMachine,
  isGatewayReportedTerminalCode,
  INTERRUPT_UNDELIVERABLE_TERMINAL,
  type AgentEventClass,
  type Machine,
  type AgentStateMachineSession,
  type AgentTurnEvent,
  type RelayedTurnState,
  type SessionTurnEndReason,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireSessionPointFromDb, requireWorkspaceSessionPointFromDb } from './access'
import {
  appendEvent,
  parseEventImages,
  parseEventAttachments,
  requireSenderSource,
  requireWritableSession,
  storedSenderMatches,
  terminalStatus,
} from './agentSessionsShared'
import { patchSessionAndReconcileDiscovery } from './discovery'
import { admitSessionId, throwSessionError } from './errors'
import { assertSessionIdentityAttribution } from './identity'
import type {
  appendSessionNoteArgs,
  finalizeUndeliverableInterruptArgs,
  finalizeDiscardedSessionArgs,
  relayRunnerEventArgs,
  requestInterruptArgs,
} from './model'

export async function relayRunnerEventImpl(
  ctx: MutationCtx,
  args: Infer<typeof relayRunnerEventArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const { session } = await requireWorkspaceSessionPointFromDb(ctx, args)
  const event = AgentTurnEventSchema.parse(args.event)
  const eventFingerprint = await fingerprintAgentRelayEvent(event, args.acceptedThroughSeq)
  const existingReceipt = await ctx.db
    .query('agentSessionRelayReceipts')
    .withIndex('by_session_relay', q => q.eq('sessionId', session._id).eq('relayId', args.relayId))
    .unique()
  if (existingReceipt !== null) {
    // A relay id is applied once. The gateway can retry one whose response was
    // lost and whose content it has since normalized — a journal record trimmed
    // to what this store can hold — so a differing payload under a known id is
    // our own doing, not a replay to refuse. Refusing it stranded the record at
    // the head of a queue nothing behind could pass. Worth saying out loud
    // though: the other way to get here is a gateway minting one id for two
    // events, and that would silently lose the second.
    if (existingReceipt.eventFingerprint !== eventFingerprint) {
      console.error(
        `agent relay ${args.relayId} reapplied with different content on session ${args.sessionId}`,
      )
    }
    return {
      status: existingReceipt.status,
      lastEventSeq: existingReceipt.lastEventSeq,
      accepted: existingReceipt.accepted,
      seq: existingReceipt.seq,
    }
  }
  const terminal = terminalStatus(event)
  const nativeInterruptedCheckpoint = isNativeInterruptedCheckpoint(session, event)
  // A terminal is accepted whatever came before it: a later terminal overrides
  // an earlier one, whoever wrote it. The gateway and this control plane end
  // turns on a runner's behalf as guesses about a process they cannot see, and
  // the runner's own word arriving afterwards is the correction, not a
  // straggler to refuse — a journal that takes the work and drops the ending
  // reads as a live turn forever.
  const refinesControlPlaneInterrupt =
    session.turnStatus === 'interrupted' && nativeInterruptedCheckpoint
  let appendedControlPlaneInterruptSeq: number | undefined
  const workspace = await ctx.db.get(args.workspaceId)
  if (
    workspace !== null &&
    (workspace.servicingStatus === 'paused' || workspace.servicingStatus === 'banned') &&
    terminal !== null &&
    !refinesControlPlaneInterrupt
  ) {
    if (nativeInterruptedCheckpoint) {
      appendedControlPlaneInterruptSeq = await terminalizeSession(
        ctx,
        args.workspaceId,
        session,
        args.now ?? Date.now(),
        'workspace_paused',
      )
    } else {
      const terminalized = await ctx.db.get(session._id)
      if (terminalized === null) throw new Error('Session not found')
      return persistRelayReceipt(ctx, args, eventFingerprint, {
        status: terminalized.turnStatus,
        lastEventSeq: terminalized.lastEventSeq,
        accepted: false,
        seq: null,
      })
    }
  }
  // The gateway ends a turn it cannot end itself — output outran the journal,
  // or the runner died without ever authoring a terminal — by reporting the
  // fact; only a runner may author a terminal, so the ending is ours to draw,
  // through the same owner that ends a turn for a paused workspace or a
  // deleted agent.
  const gatewayReportedCode = event.type === 'system' ? event.metadata?.code : undefined
  if (
    gatewayReportedCode === INTERRUPT_UNDELIVERABLE_TERMINAL &&
    args.acceptedThroughSeq !== session.lastRunnerInputSeq
  ) {
    return persistRelayReceipt(ctx, args, eventFingerprint, {
      status: session.turnStatus,
      lastEventSeq: session.lastEventSeq,
      accepted: false,
      seq: null,
    })
  }
  if (isGatewayReportedTerminalCode(gatewayReportedCode)) {
    const seq =
      session.bucket === 'done'
        ? session.lastEventSeq
        : await terminalizeSession(
            ctx,
            args.workspaceId,
            session,
            args.now ?? Date.now(),
            gatewayReportedCode,
            gatewayReportedCode === INTERRUPT_UNDELIVERABLE_TERMINAL
              ? args.acceptedThroughSeq
              : undefined,
          )
    return persistRelayReceipt(ctx, args, eventFingerprint, {
      status: 'interrupted',
      lastEventSeq: seq,
      accepted: true,
      seq: null,
    })
  }
  const eventClass = classifyAgentTurnEvent(event)
  if (eventClass === 'ephemeral') {
    return persistRelayReceipt(ctx, args, eventFingerprint, {
      status: session.turnStatus,
      lastEventSeq: session.lastEventSeq,
      accepted: false,
      seq: null,
    })
  }
  const now = args.now ?? Date.now()
  const patch: Partial<Doc<'agentSessions'>> = {
    updatedAt: now,
  }
  const seq =
    refinesControlPlaneInterrupt || appendedControlPlaneInterruptSeq !== undefined
      ? null
      : await storeRelayedAgentTurnEvent(ctx, {
          workspaceId: args.workspaceId,
          sessionId: session._id,
          event,
          eventClass,
          acceptedThroughSeq: args.acceptedThroughSeq,
          patch,
          now,
        })
  patchRunnerProjection(patch, session, event)
  // A turn beginning is a session running, and saying so is the only way a
  // restart becomes visible here. The gateway relaunches a killed turn on its
  // own — after a relay-backlog kill drains, on gateway start, coming out of
  // maintenance, on a wake — and never routes that through the control plane,
  // because the checkpoint it resumes from lives only on the VM. The fresh
  // runner announces itself the one way it can, through this event; without
  // this line the session stays whatever the kill left behind, and the resumed
  // turn's own ending is then refused as arriving at a closed turn.
  if (event.type === 'turn_started') patch.turnStatus = 'running'
  if (terminal !== null) patch.turnStatus = terminal
  patch.bucket = bucketOf({ ...session, ...patch })
  await patchSessionAndReconcileDiscovery(ctx, session, patch)
  return persistRelayReceipt(ctx, args, eventFingerprint, {
    status: patch.turnStatus ?? session.turnStatus,
    lastEventSeq: seq ?? appendedControlPlaneInterruptSeq ?? session.lastEventSeq,
    accepted: true,
    seq,
  })
}

function isNativeInterruptedCheckpoint(
  session: Doc<'agentSessions'>,
  event: AgentTurnEvent,
): boolean {
  if (
    session.machineState === undefined ||
    session.machineState.currentState === 'interrupted' ||
    event.type !== 'interrupted'
  ) {
    return false
  }
  const state: RelayedTurnState = event.state
  return (
    state.stateMachine?.currentState === 'interrupted' && state.stateMachine.terminal === undefined
  )
}

async function persistRelayReceipt(
  ctx: MutationCtx,
  args: Infer<typeof relayRunnerEventArgs>,
  eventFingerprint: string,
  result: {
    status: Doc<'agentSessions'>['turnStatus']
    lastEventSeq: number
    accepted: boolean
    seq: number | null
  },
) {
  await ctx.db.insert('agentSessionRelayReceipts', {
    workspaceId: args.workspaceId,
    sessionId: admitSessionId(ctx, args.sessionId),
    relayId: args.relayId,
    eventFingerprint,
    ...result,
    createdAt: args.now ?? Date.now(),
  })
  return result
}

async function fingerprintAgentRelayEvent(
  event: AgentTurnEvent,
  acceptedThroughSeq: number | undefined,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    acceptedThroughSeq === undefined
      ? stableJson(event)
      : stableJson({ event, acceptedThroughSeq }),
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// The terminalization sweep has one owner (D22). Two callers drive it with different
// intent, so three things are parameters on the same batched, self-rescheduling loop:
// the candidate SOURCE (a whole workspace on pause/ban, or a single agent on delete),
// the GUARD that decides whether a continuation still applies, and the REASON stamped
// on the control-plane `interrupted` marker. `interrupt_undeliverable` is the one
// reason with no sweep at all: it names the single session a user asked to stop, and
// reaches `terminalizeSession` directly.
export interface SessionTerminalizationScope {
  workspaceId: Id<'workspaces'>
  reason: SessionTurnEndReason
  // Absent = workspace source (pause/ban). Present = agent source (delete): candidates
  // are read from the agent-scoped index slice 01 added.
  agentId?: Id<'agents'>
}

export async function terminalizeOpenSessionsForWorkspace(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
): Promise<void> {
  await scheduleSessionTerminalization(ctx, { workspaceId, reason: 'workspace_paused' }, now, 0)
}

export async function terminalizeAgentSessions(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; agentId: Id<'agents'>; now: number },
): Promise<void> {
  await scheduleSessionTerminalization(
    ctx,
    { workspaceId: args.workspaceId, reason: 'agent_deleted', agentId: args.agentId },
    args.now,
    0,
  )
}

export async function terminalizeSessionsForProvisioningFailure(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
): Promise<void> {
  await scheduleSessionTerminalization(
    ctx,
    { workspaceId: args.workspaceId, reason: 'workspace_provisioning_failed' },
    args.now,
    0,
  )
}

export async function continueSessionTerminalizationForWorkspace(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
): Promise<{ done: boolean; processed: number }> {
  return continueSessionTerminalizationForScope(
    ctx,
    { workspaceId, reason: 'workspace_paused' },
    now,
  )
}

const SESSION_TERMINALIZATION_BATCH = 8
const SESSION_TERMINALIZATION_CONTINUATION_DELAY_MS = 250

export async function continueSessionTerminalizationForScope(
  ctx: MutationCtx,
  scope: SessionTerminalizationScope,
  now: number,
): Promise<{ done: boolean; processed: number }> {
  if (!(await terminalizationGuardAllows(ctx, scope))) return { done: true, processed: 0 }
  const candidates = await collectTerminalizationBatch(ctx, scope, SESSION_TERMINALIZATION_BATCH)
  let processed = 0
  for (const session of candidates) {
    await terminalizeSession(ctx, scope.workspaceId, session, now, scope.reason)
    processed += 1
  }
  const done = !(await hasSessionTerminalizationCandidate(ctx, scope))
  if (!done) {
    await scheduleSessionTerminalization(
      ctx,
      scope,
      now,
      SESSION_TERMINALIZATION_CONTINUATION_DELAY_MS,
    )
  }
  return { done, processed }
}

async function terminalizationGuardAllows(
  ctx: MutationCtx,
  scope: SessionTerminalizationScope,
): Promise<boolean> {
  const workspace = await ctx.db.get(scope.workspaceId)
  if (workspace === null) return false
  // Agent deletion is unconditional: the agent row is already gone and cannot be
  // un-deleted, so there is no servicing race to gate on. Workspace-pause only proceeds
  // while the workspace is still paused/banned, so an un-pause mid-sweep halts the loop.
  if (scope.reason === 'agent_deleted') return true
  if (scope.reason === 'workspace_provisioning_failed') return workspace.status === 'unhealthy'
  return workspace.servicingStatus === 'paused' || workspace.servicingStatus === 'banned'
}

/**
 * Every session the sweep still has to stop: anything not already finished.
 *
 * This used to be a union of two overlapping questions — sessions whose *turn*
 * was `running`/`ask`, plus sessions whose *machine* was active — deduplicated
 * into a map afterwards, because neither alone covered a just-started runner
 * (created with no machine) or a sleeping scheduled job (turn long since
 * complete). One bucket dimension answers both, so the union and the dedup are
 * gone with it.
 *
 * Both onboarding slices and both archive states are swept on purpose: hiding
 * onboarding sessions is a presentation rule, and a lifecycle sweep that
 * inherited it would leave a live runner relaying into a deleted agent.
 */
const UNFINISHED_BUCKETS = ['asking', 'running', 'scheduled'] as const

async function collectTerminalizationBatch(
  ctx: MutationCtx,
  scope: SessionTerminalizationScope,
  batchSize: number,
): Promise<Doc<'agentSessions'>[]> {
  const rows: Doc<'agentSessions'>[] = []
  for (const bucket of UNFINISHED_BUCKETS) {
    for (const onboarding of [undefined, true] as const) {
      for (const archiveState of ['active', 'archived'] as const) {
        if (rows.length >= batchSize) return rows.slice(0, batchSize)
        rows.push(
          ...(await queryUnfinished(ctx, scope, { bucket, onboarding, archiveState }, batchSize)),
        )
      }
    }
  }
  return rows.slice(0, batchSize)
}

async function queryUnfinished(
  ctx: MutationCtx,
  scope: SessionTerminalizationScope,
  slice: {
    bucket: (typeof UNFINISHED_BUCKETS)[number]
    onboarding: true | undefined
    archiveState: 'active' | 'archived'
  },
  limit: number,
): Promise<Doc<'agentSessions'>[]> {
  const agentId = scope.agentId
  if (agentId === undefined) {
    return ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_archive_bucket_updated', q =>
        q
          .eq('workspaceId', scope.workspaceId)
          .eq('onboarding', slice.onboarding)
          .eq('archiveState', slice.archiveState)
          .eq('bucket', slice.bucket),
      )
      .take(limit)
  }
  return ctx.db
    .query('agentSessions')
    .withIndex('by_workspace_agent_archive_bucket_updated', q =>
      q
        .eq('workspaceId', scope.workspaceId)
        .eq('onboarding', slice.onboarding)
        .eq('agentId', agentId)
        .eq('archiveState', slice.archiveState)
        .eq('bucket', slice.bucket),
    )
    .take(limit)
}

async function hasSessionTerminalizationCandidate(
  ctx: MutationCtx,
  scope: SessionTerminalizationScope,
): Promise<boolean> {
  return (await collectTerminalizationBatch(ctx, scope, 1)).length > 0
}

async function scheduleSessionTerminalization(
  ctx: MutationCtx,
  scope: SessionTerminalizationScope,
  now: number,
  delayMs: number,
): Promise<void> {
  await ctx.scheduler.runAfter(
    delayMs,
    makeFunctionReference(
      'domains/agentSessions/model:continueSessionTerminalization',
    ) as unknown as FunctionReference<'mutation', 'internal'>,
    {
      workspaceId: scope.workspaceId,
      now,
      reason: scope.reason,
      ...(scope.agentId === undefined ? {} : { agentId: scope.agentId }),
    },
  )
}

/**
 * The one shape of "a queued input dies undelivered": the cursor advances past
 * it, the pending flag drops, and any live delivery lease is released. Shared
 * by turn-ending terminalization and by the discarded-session finalizer, which
 * must consume a stray input without ending anything.
 */
function queuedInputConsumption(session: Doc<'agentSessions'>) {
  return {
    lastDeliveredInputSeq: Math.max(session.lastDeliveredInputSeq, session.lastRunnerInputSeq),
    runnerInputPending: false,
    deliveryAttempt: undefined,
  }
}

async function terminalizeSession(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  session: Doc<'agentSessions'>,
  now: number,
  reason: SessionTurnEndReason,
  coveredInputSeq?: number,
): Promise<number> {
  const stateMachine =
    session.machineState === undefined
      ? undefined
      : AgentStateMachineSessionSchema.parse(session.machineState)
  /* `lastRunnerInputSeq` is a required `v.number()`, so the `!== undefined`
     guard that used to be here could never fail and the `??` fallback below
     could never fire — dead defensive code around a live column. */
  // Both of these end a turn that a runner never took, so a still-queued input
  // has to die with it: a VM that will never come up cannot deliver it, and a
  // user who pressed stop does not want the next drain tick handing it to a
  // runner and re-opening the turn. Pause and agent-deletion leave the queue
  // alone — their sessions are going away with their workspace or agent.
  const consumesQueuedInput =
    reason === 'workspace_provisioning_failed' ||
    reason === 'interrupt_undeliverable' ||
    reason === 'session_discarded'
  const terminalAcceptedThroughSeq =
    consumesQueuedInput && session.runnerInputPending ? session.lastRunnerInputSeq : coveredInputSeq
  const seq = await appendEvent(ctx, {
    workspaceId,
    sessionId: session._id,
    event: { type: 'interrupted', status: 'interrupted', error: reason },
    terminal: true,
    ...(terminalAcceptedThroughSeq === undefined ? {} : { terminalAcceptedThroughSeq }),
    now,
  })
  await patchSessionAndReconcileDiscovery(ctx, session, {
    turnStatus: 'interrupted',
    lastEventSeq: seq,
    ...(consumesQueuedInput ? queuedInputConsumption(session) : {}),
    updatedAt: now,
    // Interrupted is terminal for the turn and for the machine, so both readings
    // agree and the bucket is `done` either way.
    bucket: 'done',
    ...(stateMachine === undefined
      ? {}
      : {
          machine: projectMachine(stateMachine, {
            activity: 'idle',
            outcome: 'interrupted',
          }),
        }),
  })
  return seq
}

async function storeRelayedAgentTurnEvent(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    event: AgentTurnEvent
    eventClass: Exclude<AgentEventClass, 'ephemeral'>
    acceptedThroughSeq?: number
    patch: Partial<Doc<'agentSessions'>>
    now: number
  },
): Promise<number | null> {
  switch (args.eventClass) {
    case 'canonical': {
      const terminal = terminalStatus(args.event) !== null
      const seq = await appendEvent(ctx, {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        event: leanCanonicalEvent(args.event),
        ...(terminal ? { terminal: true as const } : {}),
        ...(terminal && args.acceptedThroughSeq !== undefined
          ? { terminalAcceptedThroughSeq: args.acceptedThroughSeq }
          : {}),
        now: args.now,
      })
      args.patch.lastEventSeq = seq
      return seq
    }
    case 'doc_patch': {
      patchDocEvent(args.patch, args.event)
      const seq = await appendEvent(ctx, {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        event: args.event,
        now: args.now,
      })
      args.patch.lastEventSeq = seq
      return seq
    }
  }
}

function patchDocEvent(patch: Partial<Doc<'agentSessions'>>, event: AgentTurnEvent) {
  switch (event.type) {
    case 'todos':
      patch.todos = event.todos
      return
    case 'follow_up_queue':
      patch.followUpQueue = event.followUpQueue
      return
    case 'state_machine':
      applyStateMachineProjection(patch, event.stateMachine, 'running')
      return
  }
}

function patchRunnerProjection(
  patch: Partial<Doc<'agentSessions'>>,
  session: Doc<'agentSessions'>,
  event: AgentTurnEvent,
) {
  if (event.type === 'state_machine') return
  if (!('state' in event)) return
  // The gateway sends only this slice; a read outside it would find nothing.
  const state: RelayedTurnState = event.state
  if (state.todos !== undefined) patch.todos = state.todos
  if (state.followUpQueue !== undefined) patch.followUpQueue = state.followUpQueue
  const stateMachine = state.stateMachine
  if (stateMachine === undefined) {
    // The runner may report a turn without re-sending the machine it is
    // running. Silence is not news about the machine's shape — but a `sleep`
    // is news about its activity, and dropping it strands a job reading as live
    // work with a wake nobody can see. Carry the observation onto the existing
    // projection rather than waiting for a frame that may never come.
    if (event.type === 'sleep' && session.machine !== undefined) {
      patch.machine = {
        ...session.machine,
        activity: 'sleeping',
        nextWakeAt: event.wakeAt,
      }
    }
    return
  }
  applyStateMachineProjection(patch, stateMachine, activityForEvent(event), event)
}

function applyStateMachineProjection(
  patch: Partial<Doc<'agentSessions'>>,
  stateMachine: AgentStateMachineSession,
  activity: Machine['activity'],
  event?: AgentTurnEvent,
) {
  const nextWakeAt = event?.type === 'sleep' ? event.wakeAt : undefined
  patch.machineState = stateMachine
  // `machine.outcome` carries what `jobView` used to: it is set exactly
  // when the machine is terminal or interrupted. One projection, not two.
  patch.machine = projectMachine(stateMachine, {
    activity,
    ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
  })
}

function activityForEvent(event: AgentTurnEvent) {
  switch (event.type) {
    case 'turn_started':
      return 'running' as const
    case 'ask':
      return 'waiting' as const
    case 'sleep':
      return 'sleeping' as const
    case 'complete':
    case 'interrupted':
      return 'idle' as const
    default:
      return 'running' as const
  }
}

function leanCanonicalEvent(event: AgentTurnEvent): AgentTurnEvent | Record<string, unknown> {
  switch (event.type) {
    case 'turn_started':
      return { type: event.type }
    case 'complete':
    case 'ask':
    case 'interrupted':
    case 'sleep':
      return terminalMarkerEvent(event)
    default:
      return event
  }
}

function terminalMarkerEvent(event: AgentTurnEvent): Record<string, unknown> {
  const source = event as unknown as Record<string, unknown>
  const marker: Record<string, unknown> = { type: event.type }
  // `turnUsage`/`usageByModel` ride along: the live stream serves the full
  // terminal from the gateway buffer, so the stored marker is the only place a
  // reload can read the turn's tally from. Runner `state` stays dropped — the
  // ledger envelope owns the checkpoint.
  for (const key of [
    'status',
    'result',
    'error',
    'questions',
    'wakeAt',
    'turnUsage',
    'usageByModel',
  ] as const) {
    if (source[key] !== undefined) marker[key] = source[key]
  }
  return marker
}

export async function appendSessionNoteImpl(
  ctx: MutationCtx,
  args: Infer<typeof appendSessionNoteArgs>,
) {
  requireApiInternalKey(args.internalKey)
  assertSessionIdentityAttribution(args.identity, args.actorId)
  const { session } = await requireSessionPointFromDb(ctx, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    identity: args.identity,
  })
  const images = parseEventImages(args.images)
  const attachments = parseEventAttachments(args.attachments)
  await requireSenderSource(ctx, args.workspaceId, args.sender, args.identity)
  const existing =
    args.clientRequestId === undefined
      ? null
      : await ctx.db
          .query('agentSessionEvents')
          .withIndex('by_session_client_request', q =>
            q.eq('sessionId', session._id).eq('clientRequestId', args.clientRequestId),
          )
          .unique()
  if (existing !== null) {
    if (existing.submittingActorId === undefined) throwSessionError('idempotency_conflict')
    const event = existing.event
    const fingerprintsMatch =
      args.clientRequestFingerprint === undefined || existing.clientRequestFingerprint === undefined
        ? undefined
        : args.clientRequestFingerprint === existing.clientRequestFingerprint
    // The author is part of the request's identity even when a fingerprint
    // already matched, so a replay under a different sender is a conflict
    // rather than a silent re-attribution of the stored note.
    if (
      existing.submittingActorId !== args.actorId ||
      fingerprintsMatch === false ||
      !storedSenderMatches(event, args.sender) ||
      (fingerprintsMatch === undefined &&
        (typeof event !== 'object' ||
          event === null ||
          !('type' in event) ||
          event.type !== 'note_submitted' ||
          !('note' in event) ||
          event.note !== args.note))
    ) {
      throwSessionError('invalid_request')
    }
    return {
      status: session.turnStatus,
      seq: existing.seq,
      lastEventSeq: session.lastEventSeq,
      deduplicated: true as const,
    }
  }
  const now = args.now ?? Date.now()
  const seq = await appendEvent(ctx, {
    workspaceId: args.workspaceId,
    sessionId: session._id,
    event: {
      type: 'note_submitted',
      note: args.note,
      sender: args.sender,
      ...(args.clientRequestId === undefined ? {} : { clientRequestId: args.clientRequestId }),
      ...(images === undefined ? {} : { images }),
      ...(attachments === undefined ? {} : { attachments }),
    },
    ...(args.clientRequestId === undefined ? {} : { clientRequestId: args.clientRequestId }),
    ...(args.clientRequestFingerprint === undefined
      ? {}
      : { clientRequestFingerprint: args.clientRequestFingerprint }),
    submittingActorId: args.actorId,
    now,
  })
  await patchSessionAndReconcileDiscovery(ctx, session, {
    updatedAt: now,
    lastEventSeq: seq,
  })
  return { status: session.turnStatus, seq, lastEventSeq: seq }
}

export async function requestInterruptImpl(
  ctx: MutationCtx,
  args: Infer<typeof requestInterruptArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const { session } = await requireSessionPointFromDb(ctx, args)
  const now = args.now ?? Date.now()
  const seq = await appendEvent(ctx, {
    workspaceId: args.workspaceId,
    sessionId: session._id,
    event: { type: 'interrupt_requested', requestedAt: new Date(now).toISOString() },
    now,
  })
  await patchSessionAndReconcileDiscovery(ctx, session, {
    updatedAt: now,
    lastEventSeq: seq,
  })
  return { status: session.turnStatus, lastEventSeq: seq }
}

/**
 * The user pressed stop and the VM could not honour it — its runner was gone,
 * or the gateway never answered. The control plane ends the turn itself, so a
 * session whose runner has died cannot sit "working" forever with a stop button
 * that does nothing. A session already finished is left exactly as it is: the
 * runner's own terminal is richer than this marker.
 */
export async function finalizeUndeliverableInterruptImpl(
  ctx: MutationCtx,
  args: Infer<typeof finalizeUndeliverableInterruptArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const session = await requireWritableSession(
    ctx,
    args.workspaceId,
    admitSessionId(ctx, args.sessionId),
  )
  if (session.bucket === 'done') {
    return { status: session.turnStatus, lastEventSeq: session.lastEventSeq }
  }
  const now = args.now ?? Date.now()
  const seq = await terminalizeSession(
    ctx,
    args.workspaceId,
    session,
    now,
    'interrupt_undeliverable',
  )
  return { status: 'interrupted' as const, lastEventSeq: seq }
}

/**
 * The gateway found its envelope for this session already discarded — the
 * agent was deleted, or the session was explicitly torn down — while the
 * control plane still had queued input for it. There is nothing left on the
 * VM to settle that input into (a discarded envelope refuses writes), so the
 * control plane ends the turn itself instead of letting the next drain tick
 * find the same undeliverable input and try again. A session already
 * finished is left exactly as it is.
 */
export async function finalizeDiscardedSessionImpl(
  ctx: MutationCtx,
  args: Infer<typeof finalizeDiscardedSessionArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const session = await requireWritableSession(ctx, args.workspaceId, args.sessionId)
  if (session.bucket === 'done') {
    // The turn's real ending stands — but a stray queued input must still die
    // here. A session can reach `done` with input pending (a terminal that
    // never accepted it, an agent folder deleted out from under the queue),
    // and the drain index selects on the pending flag alone: left set, every
    // sync tick re-dispatches into the gateway's 410 forever.
    if (session.runnerInputPending) {
      await patchSessionAndReconcileDiscovery(ctx, session, {
        ...queuedInputConsumption(session),
        updatedAt: args.now ?? Date.now(),
      })
    }
    return { status: session.turnStatus, lastEventSeq: session.lastEventSeq }
  }
  const now = args.now ?? Date.now()
  const seq = await terminalizeSession(ctx, args.workspaceId, session, now, 'session_discarded')
  return { status: 'interrupted' as const, lastEventSeq: seq }
}

export async function reconcileInterruptedCheckpointImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: string
    acceptedThroughSeq: number
    expectedLastEventSeq: number
    now?: number
  },
): Promise<boolean> {
  requireApiInternalKey(args.internalKey)
  const { session } = await requireWorkspaceSessionPointFromDb(ctx, args)
  if (
    session.turnStatus !== 'running' ||
    session.archiveState !== 'active' ||
    session.runnerInputPending ||
    session.lastRunnerInputSeq !== args.acceptedThroughSeq ||
    session.lastEventSeq !== args.expectedLastEventSeq
  )
    return false
  await terminalizeSession(
    ctx,
    args.workspaceId,
    session,
    args.now ?? Date.now(),
    'runner_exited',
    args.acceptedThroughSeq,
  )
  return true
}
