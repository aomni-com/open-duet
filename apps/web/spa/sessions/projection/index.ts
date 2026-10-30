import {
  AgentSessionTimelineEventSchema,
  isKnownTimelineEvent,
  isTranscriptEvent,
  type AgentEventAttachment,
  type AgentEventImage,
  type AgentInputImage,
  type AgentFollowUpQueueEntry,
  type AgentModelUsageEntry,
  type AgentStateMachineSession,
  type AgentTodo,
  type AgentTokenUsage,
  type AgentTurnQuestion,
  type AgentTurnEvent,
  type AgentTurnState,
  type SessionInputSender,
  type SessionSnapshot,
  type SessionTimelineEntry,
  splitNamespacedToolName,
} from '@repo/contract'

export type SessionEphemeralFrame = {
  /** Durable cursor after which this live frame was observed. */
  cursor: number
  correlationId: string
  event: unknown
  /** Browser-local image bytes used only until the durable storage IDs arrive. */
  optimisticImages?: AgentInputImage[]
  createdAt?: number
}

type TurnStep = Extract<AgentTurnEvent, { type: 'step' }>['step']
type ToolCallStep = Extract<TurnStep, { type: 'tool_call' }>
type RunnerSystemEvent = Extract<AgentTurnEvent, { type: 'system' }>
type CompleteStatus = NonNullable<
  Extract<SessionTimelineEntry['event'], { type: 'complete' }>['status']
>

export type AgentSystemPart =
  | {
      kind: 'system'
      id: string
      source: 'step'
      message: string
    }
  | {
      kind: 'system'
      id: string
      source: 'runner'
      level: RunnerSystemEvent['level']
      message: string
    }

export type AgentLifecyclePart =
  | {
      kind: 'lifecycle'
      id: string
      type: 'complete'
      status?: CompleteStatus
      error?: string
    }
  | {
      kind: 'lifecycle'
      id: string
      type: 'interrupted'
      error?: string
    }
  | {
      kind: 'lifecycle'
      id: string
      type: 'sleep'
      wakeAt: number
    }

export type AgentMessagePart =
  | { kind: 'text'; id: string; text: string; pending?: boolean }
  | { kind: 'reasoning'; id: string; text: string; pending?: boolean }
  | {
      kind: 'tool'
      id: string
      toolCallId: string
      /** The tool's own name, with any MCP server's prefix decoded away. */
      name: string
      /** The MCP server that exposed it, absent for the runner's own tools. */
      server?: string
      status: 'running' | 'complete' | 'error'
      input?: Record<string, unknown>
      details?: unknown
      output?: ToolCallStep['output']
    }
  | { kind: 'ask'; id: string; questions: AgentTurnQuestion[] }
  | AgentSystemPart
  | AgentLifecyclePart

export type ProjectedInputMessage = {
  id: string
  role: 'input'
  source: 'prompt' | 'note' | 'answer'
  text: string
  sender: SessionInputSender
  images?: Array<AgentEventImage | AgentInputImage>
  attachments?: AgentEventAttachment[]
  createdAt?: number
  pending?: boolean
}

export type ProjectedAgentMessage = {
  id: string
  role: 'agent'
  finalized: boolean
  parts: AgentMessagePart[]
  createdAt?: number
  /** When the turn's terminal event landed; with `createdAt`, the turn's wall-clock span. */
  finalizedAt?: number
  turnUsage?: AgentTokenUsage
  usageByModel?: AgentModelUsageEntry[]
}

export type ProjectedMessage = ProjectedInputMessage | ProjectedAgentMessage

/**
 * The agent's first message as a synthetic timeline row — what the empty
 * chat and the pending-create shell render before the durable
 * `agent_message` event exists to replace it in place. No `createdAt` on
 * purpose: nothing has happened yet, so there is no time to show.
 */
export function agentFirstMessageProjection(id: string, text: string): ProjectedAgentMessage {
  return {
    id,
    role: 'agent',
    finalized: true,
    parts: [{ kind: 'text', id: `${id}:text`, text }],
  }
}

export type ProjectedSession = {
  cursor: number
  gapAt?: number
  messages: ProjectedMessage[]
  todos?: AgentTodo[]
  state?: AgentTurnState
  followUpQueue?: AgentFollowUpQueueEntry[]
  stateMachine?: AgentStateMachineSession
}

export function projectSession(args: {
  snapshot: SessionSnapshot
  durableEvents: readonly SessionTimelineEntry[]
  ephemeralFrames?: readonly SessionEphemeralFrame[]
  startsAtSeq?: number
  /**
   * The newest seq a history page delivered. Transcript pages skip the task
   * rail, so a hole at or below this line is normal; above it every row
   * arrived by stream, and a hole is a gap the projection stops at.
   */
  pagedThroughSeq?: number
}): ProjectedSession {
  return projectSessionInternal(args)
}

function projectSessionInternal(
  args: {
    snapshot: SessionSnapshot
    durableEvents: readonly SessionTimelineEntry[]
    ephemeralFrames?: readonly SessionEphemeralFrame[]
    startsAtSeq?: number
    pagedThroughSeq?: number
  },
  captureAccumulator?: (accumulator: ProjectionAccumulator) => void,
): ProjectedSession {
  const durableBySeq = new Map<number, SessionTimelineEntry>()
  for (const entry of args.durableEvents) durableBySeq.set(entry.seq, entry)
  const ordered = [...durableBySeq.values()].sort((left, right) => left.seq - right.seq)

  let cursor = (args.startsAtSeq ?? 1) - 1
  let gapAt: number | undefined
  const contiguous: SessionTimelineEntry[] = []
  const pagedThroughSeq = args.pagedThroughSeq ?? 0
  for (const entry of ordered) {
    if (entry.seq <= cursor) continue
    if (entry.seq > pagedThroughSeq && entry.seq !== cursor + 1) {
      gapAt = cursor + 1
      break
    }
    contiguous.push(entry)
    cursor = entry.seq
  }

  const ephemeralById = new Map<string, SessionEphemeralFrame>()
  for (const frame of args.ephemeralFrames ?? []) {
    if (frame.cursor >= 0 && frame.cursor <= cursor) ephemeralById.set(frame.correlationId, frame)
  }
  const ephemeralByCursor = new Map<number, SessionEphemeralFrame[]>()
  for (const frame of ephemeralById.values()) {
    const atCursor = ephemeralByCursor.get(frame.cursor) ?? []
    atCursor.push(frame)
    ephemeralByCursor.set(frame.cursor, atCursor)
  }

  const projection = newAccumulator()
  applyEphemeralFrames(projection, ephemeralByCursor.get(0))
  for (const entry of contiguous) {
    applyEvent(projection, entry.event, `event:${entry.seq}`, false, entry.createdAt)
    applyEphemeralFrames(projection, ephemeralByCursor.get(entry.seq))
  }

  settleAbandonedStreaming(projection)
  captureAccumulator?.(projection)

  /* The task list, follow-up queue and machine state are the row's, never
     rebuilt from events. The control plane writes those columns in the same
     mutation that appends the event that changed them, so the row is never
     behind the journal — while the history loaded here can be (a load that
     stopped short, a gap), and a replayed value would then outrank a finished
     row. The replay's job is the transcript; the live-turn poll and the
     tool-call refresh signal keep the row itself fresh. */
  return {
    cursor,
    ...(gapAt === undefined ? {} : { gapAt }),
    messages: projection.messages,
    todos: args.snapshot.todos,
    state: projection.state,
    followUpQueue: args.snapshot.followUpQueue,
    stateMachine: args.snapshot.machineState,
  }
}

export type IncrementalSessionProjector = {
  project(args: {
    snapshot: SessionSnapshot
    durableEvents: readonly SessionTimelineEntry[]
    /** Cache-owned append lineage; absent for replacement/history pages. */
    durableGeneration?: string
    ephemeralFrames?: readonly SessionEphemeralFrame[]
    optimisticFrames?: readonly SessionEphemeralFrame[]
    startsAtSeq?: number
    pagedThroughSeq?: number
  }): { projection: ProjectedSession; processedEvents: number }
}

const EMPTY_EPHEMERAL_FRAMES: readonly SessionEphemeralFrame[] = []

export function createIncrementalSessionProjector(): IncrementalSessionProjector {
  // Consumers memoize the author directory by this array. Part-only updates
  // retain it; adding/replacing a message publishes a new list identity.
  let publishedMessages: ProjectedMessage[] = []
  const publishMessages = (messages: ProjectedMessage[]) => {
    if (
      publishedMessages.length !== messages.length ||
      publishedMessages.at(-1) !== messages.at(-1)
    )
      publishedMessages = messages.slice()
    return publishedMessages
  }
  let previous:
    | {
        durableEvents: readonly SessionTimelineEntry[]
        durableGeneration: string | undefined
        startsAtSeq: number
        pagedThroughSeq: number | undefined
        projection: ProjectedSession
        accumulator: ProjectionAccumulator
        ephemeralFrames: readonly SessionEphemeralFrame[]
        ephemeralLength: number
        rollback?: () => void
        overlayIds: Set<string>
        hasOptimism: boolean
        committedFrames: Map<string, SessionEphemeralFrame>
      }
    | undefined

  return {
    project(args) {
      const frames = args.ephemeralFrames ?? EMPTY_EPHEMERAL_FRAMES
      const optimistic = args.optimisticFrames ?? EMPTY_EPHEMERAL_FRAMES
      const startsAtSeq = args.startsAtSeq ?? 1
      let extendsHistory =
        previous !== undefined &&
        previous.startsAtSeq === startsAtSeq &&
        previous.pagedThroughSeq === args.pagedThroughSeq &&
        previous.projection.gapAt === undefined &&
        (previous.durableEvents === args.durableEvents ||
          (args.durableGeneration !== undefined &&
            previous.durableGeneration === args.durableGeneration &&
            args.durableEvents.length >= previous.durableEvents.length))
      if (
        previous !== undefined &&
        extendsHistory &&
        previous.durableEvents === args.durableEvents &&
        previous.ephemeralFrames === frames &&
        previous.ephemeralLength <= frames.length &&
        optimistic.length === 0 &&
        !previous.hasOptimism &&
        previous.rollback !== undefined
      ) {
        const suffix = frames.slice(previous.ephemeralLength)
        const current = previous
        const ids = new Set<string>()
        if (
          suffix.every(frame => {
            if (
              frame.cursor !== current.projection.cursor ||
              current.overlayIds.has(frame.correlationId) ||
              ids.has(frame.correlationId)
            )
              return false
            ids.add(frame.correlationId)
            return true
          })
        ) {
          for (const id of ids) previous.overlayIds.add(id)
          applyEphemeralFrames(previous.accumulator, suffix)
          settleAbandonedStreaming(previous.accumulator)
          previous.ephemeralLength = frames.length
          previous.projection = {
            ...previous.projection,
            messages: publishMessages(previous.accumulator.messages),
            todos: args.snapshot.todos,
            followUpQueue: args.snapshot.followUpQueue,
            stateMachine: args.snapshot.machineState,
            state: previous.accumulator.state,
          }
          return { projection: previous.projection, processedEvents: suffix.length }
        }
      }
      const through = extendsHistory
        ? args.durableEvents === previous?.durableEvents
          ? previous.projection.cursor
          : (args.durableEvents.at(-1)?.seq ?? startsAtSeq - 1)
        : args.durableEvents.reduce((cursor, entry) => Math.max(cursor, entry.seq), startsAtSeq - 1)
      const overlay = [
        ...new Map(
          [...frames, ...optimistic]
            .filter(frame => frame.cursor >= 0 && frame.cursor <= through)
            .map(frame => [frame.correlationId, frame]),
        ).values(),
      ]
      const committedFrames = new Map(
        overlay
          .filter(frame => frame.cursor >= 0 && frame.cursor < through)
          .map(frame => [frame.correlationId, frame]),
      )
      if (previous !== undefined && extendsHistory) {
        const previousCursor = previous.projection.cursor
        const retained = [...committedFrames.values()]
        const prior = [...previous.committedFrames.values()]
        extendsHistory =
          prior.every((frame, index) => retained[index] === frame) &&
          retained.slice(prior.length).every(frame => frame.cursor >= previousCursor)
      }
      previous?.rollback?.()
      let accumulator: ProjectionAccumulator
      let projection: ProjectedSession
      let processedEvents: number
      if (previous !== undefined && extendsHistory) {
        accumulator = previous.accumulator
        let cursor = previous.projection.cursor
        let gapAt: number | undefined
        const suffix = args.durableEvents.slice(previous.durableEvents.length)
        processedEvents = suffix.length
        const newFramesAtCursor = new Map<number, SessionEphemeralFrame[]>()
        for (const [id, frame] of committedFrames) {
          if (previous.committedFrames.has(id)) continue
          const atCursor = newFramesAtCursor.get(frame.cursor) ?? []
          atCursor.push(frame)
          newFramesAtCursor.set(frame.cursor, atCursor)
        }
        for (const entry of suffix) {
          if (entry.seq > (args.pagedThroughSeq ?? 0) && entry.seq !== cursor + 1) {
            gapAt = cursor + 1
            break
          }
          const atCursor = newFramesAtCursor.get(cursor)
          applyEphemeralFrames(accumulator, atCursor)
          processedEvents += atCursor?.length ?? 0
          applyEvent(accumulator, entry.event, `event:${entry.seq}`, false, entry.createdAt)
          cursor = entry.seq
        }
        settleAbandonedStreaming(accumulator)
        projection = {
          cursor,
          ...(gapAt === undefined ? {} : { gapAt }),
          messages: accumulator.messages,
          todos: args.snapshot.todos,
          state: accumulator.state,
          followUpQueue: args.snapshot.followUpQueue,
          stateMachine: args.snapshot.machineState,
        }
      } else {
        accumulator = newAccumulator()
        projection = projectSessionInternal(
          { ...args, ephemeralFrames: [...committedFrames.values()] },
          value => {
            accumulator = value
          },
        )
        processedEvents = args.durableEvents.length + committedFrames.size
      }
      if (projection.gapAt !== undefined) {
        previous = undefined
        const view = projectSessionInternal({
          ...args,
          ephemeralFrames: [...frames, ...optimistic],
        })
        return {
          projection: { ...view, messages: publishMessages(view.messages) },
          processedEvents: processedEvents + args.durableEvents.length + overlay.length,
        }
      }
      const tail = overlay.filter(frame => frame.cursor === projection.cursor)
      let rollback: (() => void) | undefined
      if (tail.length > 0) {
        rollback = beginOverlay(accumulator)
        applyEphemeralFrames(accumulator, tail)
        settleAbandonedStreaming(accumulator)
        projection = { ...projection, state: accumulator.state }
        processedEvents += tail.length
      }
      projection = { ...projection, messages: publishMessages(accumulator.messages) }
      previous = {
        durableEvents: args.durableEvents,
        durableGeneration: args.durableGeneration,
        startsAtSeq,
        pagedThroughSeq: args.pagedThroughSeq,
        projection,
        accumulator,
        ephemeralFrames: frames,
        ephemeralLength: frames.length,
        rollback,
        overlayIds: new Set(overlay.map(frame => frame.correlationId)),
        hasOptimism: optimistic.length > 0,
        committedFrames,
      }
      return { projection, processedEvents }
    },
  }
}

/**
 * `pending` on a text/reasoning part means "built from stream deltas, awaiting
 * its canonical step". Canonical `text` steps always arrive, but some
 * transports never deliver the canonical `reasoning` step, so a part the
 * stream has already moved past would read as streaming forever. Anything
 * that is not the tail of the transcript is settled content: only the last
 * part of the last message can still be receiving deltas.
 */
function settleAbandonedStreaming(projection: ProjectionAccumulator): void {
  const lastMessage = projection.messages.at(-1)
  const tail = lastMessage?.role === 'agent' ? lastMessage.parts.at(-1) : undefined
  for (const part of projection.streamingParts) {
    if (part === tail) continue
    delete part.pending
    projection.streamingParts.delete(part)
  }
}

type StreamingPart = Extract<AgentMessagePart, { kind: 'text' | 'reasoning' }>
type ProjectionAccumulator = {
  messages: ProjectedMessage[]
  openAgent?: ProjectedAgentMessage
  state?: AgentTurnState
  tools: Map<string, number>
  pendingByKind: Map<'text' | 'reasoning', number>
  streamingParts: Set<StreamingPart>
  beforeReplace?: (parts: AgentMessagePart[], index: number) => void
  beforeToolInsert?: (id: string) => void
}

function newAccumulator(): ProjectionAccumulator {
  return { messages: [], tools: new Map(), pendingByKind: new Map(), streamingParts: new Set() }
}

/** Reversible live tail: copy only the slots it changes, never the transcript. */
function beginOverlay(projection: ProjectionAccumulator): () => void {
  const messageCount = projection.messages.length
  const agent = projection.openAgent
  const agentBefore = agent === undefined ? undefined : { ...agent }
  const partCount = agent?.parts.length ?? 0
  const replaced = new Map<number, AgentMessagePart>()
  const tools = projection.tools
  const insertedTools: string[] = []
  const pendingByKind = new Map(projection.pendingByKind)
  const streamingParts = new Set(projection.streamingParts)
  const state = projection.state
  projection.beforeReplace = (parts, index) => {
    if (parts === agent?.parts && index < partCount && !replaced.has(index))
      replaced.set(index, parts[index]!)
  }
  projection.beforeToolInsert = id => {
    if (projection.tools === tools) insertedTools.push(id)
  }
  return () => {
    projection.messages.length = messageCount
    if (agent !== undefined && agentBefore !== undefined) {
      for (const key of Object.keys(agent)) Reflect.deleteProperty(agent, key)
      Object.assign(agent, agentBefore)
      agent.parts.length = partCount
      for (const [index, part] of replaced) agent.parts[index] = part
    }
    for (const id of insertedTools) tools.delete(id)
    for (const part of streamingParts) part.pending = true
    projection.openAgent = agent
    projection.state = state
    projection.tools = tools
    projection.pendingByKind = pendingByKind
    projection.streamingParts = streamingParts
    projection.beforeReplace = undefined
    projection.beforeToolInsert = undefined
  }
}

function replacePart(
  projection: ProjectionAccumulator,
  message: ProjectedAgentMessage,
  index: number,
  part: AgentMessagePart,
): void {
  projection.beforeReplace?.(message.parts, index)
  message.parts[index] = part
}

function applyEphemeralFrames(
  projection: ProjectionAccumulator,
  frames: readonly SessionEphemeralFrame[] | undefined,
): void {
  for (const frame of frames ?? []) {
    const parsed = AgentSessionTimelineEventSchema.safeParse(frame.event)
    if (parsed.success)
      applyEvent(
        projection,
        parsed.data,
        `frame:${frame.correlationId}`,
        true,
        frame.createdAt,
        frame.optimisticImages,
      )
  }
}

function applyEvent(
  projection: ProjectionAccumulator,
  event: SessionTimelineEntry['event'],
  id: string,
  pending: boolean,
  createdAt?: number,
  optimisticImages?: AgentInputImage[],
): void {
  // An event type from a newer deploy: opaque by contract (map D10). Renders
  // nothing — never a phantom agent bubble.
  if (!isKnownTimelineEvent(event)) return
  if ('state' in event && event.state !== undefined) projection.state = event.state

  switch (event.type) {
    case 'session_created':
    case 'interrupt_requested':
      return
    // The agent's materialized first message: its own finalized bubble, never
    // merged into a turn container — there is no turn, and the very next
    // event is the user's prompt.
    case 'agent_message':
      projection.messages.push({
        id: `agent-message:${id}`,
        role: 'agent',
        finalized: true,
        parts: [{ kind: 'text', id, text: event.message }],
        ...(createdAt === undefined ? {} : { createdAt }),
      })
      return
    case 'prompt_submitted':
      appendInputMessage(
        projection,
        id,
        'prompt',
        event.prompt,
        event.sender,
        optimisticImages ?? event.images,
        event.attachments,
        pending,
        createdAt,
      )
      return
    case 'note_submitted':
      appendInputMessage(
        projection,
        id,
        'note',
        event.note,
        event.sender,
        optimisticImages ?? event.images,
        event.attachments,
        pending,
        createdAt,
      )
      return
    case 'answer_submitted':
      appendInputMessage(
        projection,
        id,
        'answer',
        event.answer,
        event.sender,
        optimisticImages ?? event.images,
        event.attachments,
        pending,
        createdAt,
      )
      return
  }

  // The task rail and child-backed steps are runtime plumbing, not transcript.
  // The same predicate stamps the rows the transcript view pages by, so what
  // the server skips and what the projection drops cannot drift apart.
  if (!isTranscriptEvent(event)) return

  const message = ensureAgentMessage(projection, id, createdAt)
  switch (event.type) {
    case 'turn_started':
    case 'memory':
    case 'usage':
    case 'heartbeat':
    case 'router_switch':
      return
    case 'todos':
    case 'follow_up_queue':
    case 'state_machine':
      // Row-owned document state: the control plane writes these onto the
      // session row in the same mutation that appends the event, and the
      // projection reads them from the row. See `projectSession`.
      return
    case 'step':
      applyStep(projection, message, event.step, id, pending)
      return
    case 'ask':
      appendAgentPart(projection, message, {
        kind: 'ask',
        id,
        questions: event.questions,
      })
      settleTurn(message, event, createdAt)
      finalizeAgentMessage(projection)
      return
    // event.result repeats the turn's last text step, which already projected
    // as its own part, so it stays out of the lifecycle part.
    case 'complete':
      appendAgentPart(projection, message, {
        kind: 'lifecycle',
        id,
        type: 'complete',
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(typeof event.error === 'string' ? { error: event.error } : {}),
      })
      settleTurn(message, event, createdAt)
      finalizeAgentMessage(projection)
      return
    case 'interrupted':
      appendAgentPart(projection, message, {
        kind: 'lifecycle',
        id,
        type: 'interrupted',
        ...('error' in event && typeof event.error === 'string' ? { error: event.error } : {}),
      })
      settleTurn(message, event, createdAt)
      finalizeAgentMessage(projection)
      return
    case 'sleep':
      appendAgentPart(projection, message, {
        kind: 'lifecycle',
        id,
        type: 'sleep',
        wakeAt: event.wakeAt,
      })
      settleTurn(message, event, createdAt)
      finalizeAgentMessage(projection)
      return
    case 'system':
      appendAgentPart(projection, message, {
        kind: 'system',
        id,
        source: 'runner',
        level: event.level,
        message: event.message,
      })
      return
  }
}

function appendInputMessage(
  projection: ProjectionAccumulator,
  id: string,
  source: ProjectedInputMessage['source'],
  text: string,
  sender: SessionInputSender,
  images: Array<AgentEventImage | AgentInputImage> | undefined,
  attachments: AgentEventAttachment[] | undefined,
  pending: boolean,
  createdAt: number | undefined,
): void {
  finalizeAgentMessage(projection)
  projection.messages.push({
    id,
    role: 'input',
    source,
    text,
    sender,
    ...(images === undefined ? {} : { images }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(pending ? { pending: true } : {}),
  })
}

function ensureAgentMessage(
  projection: ProjectionAccumulator,
  boundaryId: string,
  createdAt: number | undefined,
) {
  if (projection.openAgent !== undefined) {
    if (projection.openAgent.createdAt === undefined && createdAt !== undefined) {
      projection.openAgent.createdAt = createdAt
    }
    return projection.openAgent
  }
  const message: ProjectedAgentMessage = {
    id: `agent:${boundaryId}`,
    role: 'agent',
    finalized: false,
    parts: [],
    ...(createdAt === undefined ? {} : { createdAt }),
  }
  projection.openAgent = message
  return message
}

function appendAgentPart(
  projection: ProjectionAccumulator,
  message: ProjectedAgentMessage,
  part: AgentMessagePart,
): void {
  if (message.parts.length === 0) projection.messages.push(message)
  message.parts.push(part)
  if ((part.kind === 'text' || part.kind === 'reasoning') && part.pending) {
    projection.streamingParts.add(part)
    projection.pendingByKind.set(part.kind, message.parts.length - 1)
  }
}

/**
 * A terminal event is the only carrier of the turn's usage tally, and its
 * envelope clock closes the turn's wall-clock span. Legacy stored markers
 * predate the usage fields, hence the `in` guards.
 */
function settleTurn(
  message: ProjectedAgentMessage,
  event: Extract<
    SessionTimelineEntry['event'],
    { type: 'complete' | 'ask' | 'interrupted' | 'sleep' }
  >,
  createdAt: number | undefined,
): void {
  if (createdAt !== undefined) message.finalizedAt = createdAt
  if ('turnUsage' in event && event.turnUsage !== undefined) message.turnUsage = event.turnUsage
  if ('usageByModel' in event && event.usageByModel !== undefined && event.usageByModel.length > 0)
    message.usageByModel = event.usageByModel
}

function finalizeAgentMessage(projection: ProjectionAccumulator): void {
  if (projection.openAgent === undefined) return
  projection.openAgent.finalized = true
  projection.openAgent = undefined
  projection.tools = new Map()
  projection.pendingByKind = new Map()
}

function applyStep(
  projection: ProjectionAccumulator,
  message: ProjectedAgentMessage,
  step: TurnStep,
  id: string,
  pending: boolean,
): void {
  switch (step.type) {
    case 'text_delta':
      upsertStreamingText(projection, message, 'text', id, step.delta)
      return
    case 'reasoning_delta':
      upsertStreamingText(projection, message, 'reasoning', id, step.delta)
      return
    case 'text':
      replaceLatestPending(projection, message, 'text', {
        kind: 'text',
        id,
        text: step.text,
        ...(pending ? { pending: true } : {}),
      })
      return
    case 'reasoning':
      replaceLatestPending(projection, message, 'reasoning', {
        kind: 'reasoning',
        id,
        text: step.text,
        ...(pending ? { pending: true } : {}),
      })
      return
    /* The runner joins an MCP server's name onto each of its tools, so the
       name itself carries the server: decoding it here keeps this projection
       pure — no list of which servers exist, so a deleted server's historical
       calls still read correctly, and the server is known from the first
       streaming frame rather than arriving later with `details`. */
    case 'tool_call_start': {
      const namespaced = splitNamespacedToolName(step.toolName)
      upsertTool(projection, message, {
        kind: 'tool',
        id,
        toolCallId: step.toolCallId,
        name: namespaced?.tool ?? step.toolName,
        ...(namespaced === null ? {} : { server: namespaced.server }),
        status: 'running',
        ...(step.input === undefined ? {} : { input: step.input }),
      })
      return
    }
    case 'tool_call': {
      const namespaced = splitNamespacedToolName(step.toolName)
      upsertTool(projection, message, {
        kind: 'tool',
        id,
        toolCallId: step.toolCallId,
        name: namespaced?.tool ?? step.toolName,
        ...(namespaced === null ? {} : { server: namespaced.server }),
        status: step.isError ? 'error' : 'complete',
        ...(step.input === undefined ? {} : { input: step.input }),
        ...(step.details === undefined ? {} : { details: step.details }),
        ...(step.output === undefined ? {} : { output: step.output }),
      })
      return
    }
    case 'system':
      appendAgentPart(projection, message, {
        kind: 'system',
        id,
        source: 'step',
        message: step.message,
      })
  }
}

function upsertStreamingText(
  projection: ProjectionAccumulator,
  message: ProjectedAgentMessage,
  kind: 'text' | 'reasoning',
  id: string,
  delta: string,
): void {
  const latest = message.parts.at(-1)
  if (latest?.kind === kind && latest.pending === true) {
    const updated = { ...latest, text: latest.text + delta }
    replacePart(projection, message, message.parts.length - 1, updated)
    projection.streamingParts.delete(latest)
    projection.streamingParts.add(updated)
    return
  }
  appendAgentPart(projection, message, { kind, id, text: delta, pending: true })
}

function replaceLatestPending(
  projection: ProjectionAccumulator,
  message: ProjectedAgentMessage,
  kind: 'text' | 'reasoning',
  canonical: Extract<AgentMessagePart, { kind: 'text' | 'reasoning' }>,
): void {
  const index = projection.pendingByKind.get(kind)
  if (index === undefined) appendAgentPart(projection, message, canonical)
  else {
    projection.streamingParts.delete(message.parts[index] as StreamingPart)
    replacePart(projection, message, index, canonical)
    projection.pendingByKind.delete(kind)
    if (canonical.pending) {
      projection.streamingParts.add(canonical)
      projection.pendingByKind.set(kind, index)
    }
  }
}

function upsertTool(
  projection: ProjectionAccumulator,
  message: ProjectedAgentMessage,
  tool: Extract<AgentMessagePart, { kind: 'tool' }>,
): void {
  const index = projection.tools.get(tool.toolCallId)
  if (index === undefined) {
    projection.beforeToolInsert?.(tool.toolCallId)
    projection.tools.set(tool.toolCallId, message.parts.length)
    appendAgentPart(projection, message, tool)
  } else replacePart(projection, message, index, tool)
}
