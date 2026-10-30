import type {
  StateMachineDefinition,
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineState,
  StateMachineTerminalResult,
  TaskDescriptor,
  TaskId,
  TaskSettlement,
  RpcCommandAcceptedEvent,
  TurnCommand,
  TurnEvent,
  TurnFollowUpQueueEntry,
  TurnState,
  TurnStep,
  TurnTodo,
} from '@repo/agent/protocol'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import { z } from 'zod'

import { ConnectedProviderIdSchema } from '../connected-providers/index'
import { STORAGE_FULL_ERROR } from '../files/index'
import { MAX_MCP_SERVERS_PER_WORKSPACE, McpServerNameSchema } from '../mcp/naming'
import { ModelSelectionIdSchema } from '../model-tiers/index'
import { WorkspaceSlugSchema } from '../slug/index'
import { WORKSPACE_MEMBER_LIMIT } from '../workspaces/limits'
import { AGENT_INPUT_ATTACHMENT_MAX_COUNT, AgentEventAttachmentSchema } from './attachments'
import { AgentCwdSchema } from './cwd'

export * from './attachments'
export * from './cwd'

export const SESSION_CWD_FALLBACK = 'session_cwd_fallback' as const
export const BOUND_AGENT_ROOT_UNAVAILABLE = 'bound_agent_root_unavailable' as const
/**
 * The gateway stopped a turn because the control plane had fallen too far
 * behind to journal its output. It travels as a system event because only the
 * runner may author a terminal — the control plane reads this code and ends
 * the turn itself, the same way a paused workspace or a deleted agent does.
 */
export const RELAY_BACKLOG_TERMINAL = 'relay_backlog' as const

/**
 * The runner process exited without ever authoring a terminal — a crash, an
 * OOM kill, a signal. The gateway is the only party positioned to notice
 * (it holds the process), so it reports the fact as a system event the same
 * way it reports a relay backlog, and the control plane ends the turn.
 */
export const RUNNER_EXITED_TERMINAL = 'runner_exited' as const
export const INTERRUPT_UNDELIVERABLE_TERMINAL = 'interrupt_undeliverable' as const

/**
 * The control plane refused one event for long enough that retrying it is no
 * longer a recovery strategy. A payload it cannot accept never becomes
 * acceptable, and it sits at the head of the journal blocking every event
 * behind it, so the turn reads as live forever while the drain re-sends the
 * same doomed bytes every few seconds (2026-08-19). Dropping that event and
 * reporting the fact ends the turn, which is worse than delivering it and far
 * better than a session nobody can finish.
 */
export const RELAY_UNDELIVERABLE_TERMINAL = 'relay_undeliverable' as const

/**
 * Only a runner may author a terminal. These are the codes with which the
 * gateway reports a turn the runner never got to end, and the control plane
 * draws the ending from them.
 */
export const GATEWAY_REPORTED_TERMINAL_CODES = [
  RELAY_BACKLOG_TERMINAL,
  RUNNER_EXITED_TERMINAL,
  RELAY_UNDELIVERABLE_TERMINAL,
  INTERRUPT_UNDELIVERABLE_TERMINAL,
] as const

export function isGatewayReportedTerminalCode(
  code: string | undefined,
): code is (typeof GATEWAY_REPORTED_TERMINAL_CODES)[number] {
  return code !== undefined && (GATEWAY_REPORTED_TERMINAL_CODES as readonly string[]).includes(code)
}

export const AGENT_TERMINAL_STATES = ['complete', 'ask', 'interrupted', 'sleep'] as const
export const AGENT_SESSION_STATUSES = ['running', ...AGENT_TERMINAL_STATES] as const
export const AGENT_PROMPT_BEHAVIORS = ['steer', 'follow_up'] as const

export const AgentTerminalStateSchema = z.enum(AGENT_TERMINAL_STATES)

export const AgentSessionStatusSchema = z.enum(AGENT_SESSION_STATUSES)
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>

export const AgentPromptBehaviorSchema = z.enum(AGENT_PROMPT_BEHAVIORS)
export type AgentPromptBehavior = z.infer<typeof AgentPromptBehaviorSchema>

const UnknownRecordSchema = z.record(z.string(), z.unknown())

export const AgentTodoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
}) satisfies z.ZodType<TurnTodo>
export type AgentTodo = z.infer<typeof AgentTodoSchema>

const AgentPromptImageSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
})

export const AgentFollowUpQueueEntrySchema = z.object({
  message: z.string(),
  images: z.array(AgentPromptImageSchema).optional(),
}) satisfies z.ZodType<TurnFollowUpQueueEntry>
export type AgentFollowUpQueueEntry = z.infer<typeof AgentFollowUpQueueEntrySchema>

// State definitions are intentionally shallow here. duet-agent owns the set of
// state kinds and their interiors; Duet owns the durable session envelope.
const AgentStateMachineStateSchema = UnknownRecordSchema as unknown as z.ZodType<StateMachineState>
const AgentStateMachineHistoryEventSchema =
  UnknownRecordSchema as unknown as z.ZodType<StateMachineSessionEvent>
const AgentStateMachineProgressSchema = z
  .object({ states: z.record(z.string(), UnknownRecordSchema) })
  // Runner-owned progress is persisted in the session ledger and must round-trip intact.
  .loose() as unknown as z.ZodType<NonNullable<StateMachineSession['progress']>>
const AgentStateMachineTerminalSchema =
  UnknownRecordSchema as unknown as z.ZodType<StateMachineTerminalResult>

export const AgentStateMachineDefinitionSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  states: z.array(AgentStateMachineStateSchema),
}) satisfies z.ZodType<StateMachineDefinition>
export type AgentStateMachineDefinition = StateMachineDefinition
export type AgentStateMachineState = StateMachineState
export type AgentStateMachineHistoryEvent = StateMachineSessionEvent
export type AgentStateMachineProgress = NonNullable<StateMachineSession['progress']>
export type AgentStateMachineTerminal = StateMachineTerminalResult

// Duet API policy: session creation rejects schedules that could impose a tighter cadence.
export const MIN_SCHEDULE_INTERVAL_MS = 30_000

const SCHEDULE_DURATION_UNITS_MS: Record<string, number> = {
  millisecond: 1,
  milliseconds: 1,
  msec: 1,
  msecs: 1,
  ms: 1,
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  s: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  d: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
  w: 604_800_000,
  year: 31_557_600_000,
  years: 31_557_600_000,
  yr: 31_557_600_000,
  yrs: 31_557_600_000,
  y: 31_557_600_000,
}

function scheduleDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > 100) return undefined
  const match = /^(-?(?:\d+)?\.?\d+) *([a-z]+)?$/i.exec(trimmed)
  if (match === null || match[1] === undefined) return undefined
  const unitMs = SCHEDULE_DURATION_UNITS_MS[(match[2] ?? 'ms').toLowerCase()]
  return unitMs === undefined ? undefined : Number.parseFloat(match[1]) * unitMs
}

function scheduleFloorHolds(definition: AgentStateMachineDefinition | undefined): boolean {
  if (definition === undefined) return true
  for (const state of definition.states) {
    const record = state as unknown as Record<string, unknown>
    const schedule =
      record.kind === 'poll'
        ? scheduleDurationMs(record.intervalMs)
        : record.kind === 'timer' && record.wakeAfterMs !== undefined
          ? scheduleDurationMs(record.wakeAfterMs)
          : undefined
    if (schedule !== undefined && schedule < MIN_SCHEDULE_INTERVAL_MS) return false
  }
  return true
}

export const AgentStateMachineSessionSchema = z.object({
  definition: AgentStateMachineDefinitionSchema,
  prompt: z.string(),
  currentState: z.string().optional(),
  currentInput: UnknownRecordSchema.optional(),
  progress: AgentStateMachineProgressSchema.optional(),
  history: z.array(AgentStateMachineHistoryEventSchema),
  terminal: AgentStateMachineTerminalSchema.optional(),
  terminalAcknowledged: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<StateMachineSession>
export type AgentStateMachineSession = z.infer<typeof AgentStateMachineSessionSchema>

const TaskIdSchema = z.string().regex(/^t\d+$/) as z.ZodType<TaskId>
const TaskOwnerScopeIdSchema = z.union([
  z.string().regex(/^turn-\d+$/),
  z.string().regex(/^task:t\d+$/),
]) as unknown as z.ZodType<TaskDescriptor['ownerScopeId']>

const AgentTaskDescriptorSchema = z.object({
  id: TaskIdSchema,
  kind: z.enum(['tool', 'subagent', 'scheduled']),
  name: z.string(),
  label: z.string(),
  ownerScopeId: TaskOwnerScopeIdSchema,
  status: z.enum(['running', 'scheduled', 'completed', 'failed', 'stopped', 'lost']),
  startedAt: z.number(),
  wakeAt: z.number().optional(),
}) satisfies z.ZodType<TaskDescriptor>

export const AgentTurnQuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
})

export type AgentTurnQuestion = z.infer<typeof AgentTurnQuestionSchema>

/**
 * The agent's own turn commands, unextended.
 *
 * A prompt carries NO tier. Tiers are a Duet concept; duet-agent only knows
 * virtual models, and its `TurnPromptCommand` has no field for one — a tier
 * reaches it exactly once, as the `--model <tier>` spawn flag. Since the RPC
 * process lives for a single turn ("the process exits as soon as that terminal
 * lands", the agent's own rpc.ts), spawning IS the per-turn switch: the next
 * turn gets a new process with the new tier. A `tier` on the prompt command
 * would only ever mean mid-turn switching, which is neither wanted nor
 * supported.
 */
export type AgentTurnCommand = TurnCommand

export const AgentTurnCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('prompt'),
    message: z.string(),
    behavior: AgentPromptBehaviorSchema,
    images: z.array(AgentPromptImageSchema).optional(),
  }),
  z.object({
    type: z.literal('answer'),
    questions: z.array(AgentTurnQuestionSchema),
    answers: z.record(z.string(), z.array(z.string())),
    behavior: AgentPromptBehaviorSchema,
    message: z.string().optional(),
    images: z.array(AgentPromptImageSchema).optional(),
  }),
  z.object({ type: z.literal('wake') }),
]) satisfies z.ZodType<AgentTurnCommand>

const AgentStoredMessageSchema = z
  .object({ role: z.string() })
  // Runner-owned messages are persisted in the session ledger and must round-trip intact.
  .loose() as unknown as z.ZodType<TurnState['agent']['messages'][number]>

export const AgentTurnStateSchema: z.ZodType<TurnState> = z.object({
  status: z.enum([
    'running',
    'waiting_for_human',
    'sleeping',
    'interrupted',
    'completed',
    'failed',
    'cancelled',
  ]),
  mode: z.union([z.literal('agent'), z.literal('auto'), AgentStateMachineDefinitionSchema]),
  options: z
    .object({
      model: z.string().optional(),
      memoryModel: z.string().optional(),
      thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    })

    .optional(),
  agent: z.object({
    status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled']),
    messages: z.array(AgentStoredMessageSchema),
  }),
  stateMachine: AgentStateMachineSessionSchema.optional(),
  pendingStateTransition: z.object({ stateName: z.string() }).optional(),
  todos: z.array(AgentTodoSchema).optional(),
  followUpQueue: z.array(AgentFollowUpQueueEntrySchema).optional(),
  queuedCommands: z.array(AgentTurnCommandSchema).optional(),
  tasks: z.array(AgentTaskDescriptorSchema).optional(),
  taskOutputTails: z.record(TaskIdSchema, z.array(z.string())).optional(),
  pendingLostTaskReminderTaskIds: z.array(TaskIdSchema).optional(),
  nextTaskId: z.number().optional(),
  wireGuardHorizon: z.object({ evictionHorizon: z.number() }).optional(),
})

export type AgentTurnState = TurnState

/**
 * The slice of a turn's state that leaves the VM.
 *
 * `state` rides on `turn_started` and on every terminal. The control plane
 * projects todos, the follow-up queue and the state machine off it and reads
 * nothing else; the rest is the runner's working memory, and the copy a later
 * turn resumes from is the checkpoint on the VM. On the wire that remainder is
 * read by nobody and is what breaks the relay — a transcript that exhausted
 * the mutation's memory, a task map with more keys than one Convex value may
 * hold — and a refused relay retries the same payload until the turn is given
 * up. The schema still requires the status, mode and agent envelope, so those
 * travel with the transcript emptied. The gateway projects with this and the
 * control plane reads through the type, so a new read widens the slice here
 * before anything else.
 */
export type RelayedTurnState = Pick<
  AgentTurnState,
  'status' | 'mode' | 'agent' | 'stateMachine' | 'todos' | 'followUpQueue'
>

export function relayedTurnState(state: AgentTurnState): RelayedTurnState {
  const relayed: RelayedTurnState = {
    status: state.status,
    mode: state.mode,
    agent: { status: state.agent.status, messages: [] },
  }
  if (state.stateMachine !== undefined) relayed.stateMachine = state.stateMachine
  if (state.todos !== undefined) relayed.todos = state.todos
  if (state.followUpQueue !== undefined) relayed.followUpQueue = state.followUpQueue
  return relayed
}

const AgentTurnStartedEventSchema = z.object({
  type: z.literal('turn_started'),
  state: AgentTurnStateSchema,
})

const ToolCallInputSchema = z.record(z.string(), z.any()).optional()
const ToolCallOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
]) satisfies z.ZodType<TextContent | ImageContent>

export const TurnStepSchema: z.ZodType<TurnStep> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), delta: z.string() }),
  z.object({ type: z.literal('reasoning_delta'), delta: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({
    type: z.literal('tool_call_start'),
    toolName: z.string(),
    toolCallId: z.string(),
    input: ToolCallInputSchema,
  }),
  z.object({
    type: z.literal('tool_call'),
    toolName: z.string(),
    toolCallId: z.string(),
    input: ToolCallInputSchema,
    isError: z.boolean(),
    output: z.array(ToolCallOutputSchema).optional(),
    details: z.unknown().optional(),
  }),
  z.object({ type: z.literal('system'), message: z.string() }),
])

const TurnEventOriginSchema = z.object({ taskId: TaskIdSchema })

const AgentTaskSettlementSchema = z.discriminatedUnion('status', [
  z.object({
    id: TaskIdSchema,
    status: z.literal('completed'),
    settledAt: z.number(),
    result: z.unknown(),
  }),
  z.object({
    id: TaskIdSchema,
    status: z.literal('failed'),
    settledAt: z.number(),
    error: z.unknown(),
  }),
  z.object({
    id: TaskIdSchema,
    status: z.literal('stopped'),
    settledAt: z.number(),
    reason: z.string(),
  }),
  z.object({ id: TaskIdSchema, status: z.literal('lost'), settledAt: z.number() }),
]) satisfies z.ZodType<TaskSettlement>

export const AgentTokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
})

const AgentContextWindowUsageSchema = z.object({
  systemPrompt: z.number(),
  messages: z.number(),
  localMemory: z.number(),
  globalMemory: z.number(),
})

export const AgentModelUsageEntrySchema = z.object({
  model: z.string(),
  transport: z.object({
    provider: z.union([
      z.enum(['duet-gateway', 'vercel-ai-gateway', 'openrouter']),
      ConnectedProviderIdSchema,
    ]),
    billing: z.enum(['plan-covered', 'metered']),
  }),
  usage: AgentTokenUsageSchema,
})

export type AgentTokenUsage = z.infer<typeof AgentTokenUsageSchema>
export type AgentModelUsageEntry = z.infer<typeof AgentModelUsageEntrySchema>

const AgentUsageFieldsShape = {
  turnUsage: AgentTokenUsageSchema,
  usageByModel: z.array(AgentModelUsageEntrySchema),
  lastMessageUsage: AgentTokenUsageSchema,
  effectiveContextWindow: z.number(),
  contextWindowUsage: AgentContextWindowUsageSchema,
}

const AgentObservationSchema = UnknownRecordSchema as unknown as z.ZodType<
  Extract<TurnEvent, { type: 'memory' }>['observations'] extends Array<infer T> | undefined
    ? T
    : never
>

const AgentMemoryEventSchema = z.object({
  type: z.literal('memory'),
  phase: z.enum(['observation', 'reflection']),
  status: z.enum(['running', 'completed']),
  message: z.string(),
  observations: z.array(AgentObservationSchema).optional(),
  usageBumpedObservations: z.array(AgentObservationSchema).optional(),
})

const AgentUsageEventSchema = z.object({
  type: z.literal('usage'),
  ...AgentUsageFieldsShape,
  origin: TurnEventOriginSchema.optional(),
})

const AgentOptionalUsageFieldsShape = {
  turnUsage: AgentTokenUsageSchema.optional(),
  usageByModel: z.array(AgentModelUsageEntrySchema).optional(),
  lastMessageUsage: AgentTokenUsageSchema.optional(),
  effectiveContextWindow: z.number().optional(),
  contextWindowUsage: AgentContextWindowUsageSchema.optional(),
}

type AgentSystemEvent = Extract<TurnEvent, { type: 'system' }> & {
  metadata?: {
    code:
      | typeof STORAGE_FULL_ERROR
      | typeof SESSION_CWD_FALLBACK
      | typeof BOUND_AGENT_ROOT_UNAVAILABLE
      | typeof RELAY_BACKLOG_TERMINAL
      | typeof RUNNER_EXITED_TERMINAL
      | typeof RELAY_UNDELIVERABLE_TERMINAL
      | typeof INTERRUPT_UNDELIVERABLE_TERMINAL
  }
}

export type AgentTurnEvent = Exclude<TurnEvent, { type: 'system' }> | AgentSystemEvent

export const AgentTurnEventSchema: z.ZodType<AgentTurnEvent> = z.discriminatedUnion('type', [
  AgentTurnStartedEventSchema,
  z.object({
    type: z.literal('step'),
    step: TurnStepSchema,
    origin: TurnEventOriginSchema.optional(),
  }),
  z.object({
    type: z.literal('task_started'),
    task: AgentTaskDescriptorSchema,
    origin: TurnEventOriginSchema.optional(),
  }),
  z.object({
    type: z.literal('task_output'),
    taskId: TaskIdSchema,
    chunk: z.string(),
    origin: TurnEventOriginSchema.optional(),
  }),
  z.object({
    type: z.literal('task_settled'),
    settlement: AgentTaskSettlementSchema,
    origin: TurnEventOriginSchema.optional(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    timestamp: z.number(),
    activeTaskIds: z.array(TaskIdSchema),
  }),
  z.object({ type: z.literal('todos'), todos: z.array(AgentTodoSchema) }),
  z.object({
    type: z.literal('follow_up_queue'),
    followUpQueue: z.array(AgentFollowUpQueueEntrySchema),
  }),
  z.object({ type: z.literal('state_machine'), stateMachine: AgentStateMachineSessionSchema }),
  AgentMemoryEventSchema,
  AgentUsageEventSchema,
  z.object({
    type: z.literal('system'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    metadata: z
      .object({
        code: z.enum([
          STORAGE_FULL_ERROR,
          SESSION_CWD_FALLBACK,
          BOUND_AGENT_ROOT_UNAVAILABLE,
          ...GATEWAY_REPORTED_TERMINAL_CODES,
        ]),
      })

      .optional(),
  }),
  z.object({
    type: z.literal('router_switch'),
    tier: z.string(),
    route: z.string(),
    fromModel: z.string(),
    toModel: z.string(),
    thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']),
    trigger: z.enum(['turn_start', 'cadence', 'advisor', 'step_trigger', 'compaction']),
    // A decision explains itself the way its classifier does: prose from a chat
    // model, a probability per route from an evaluation model. Neither is
    // fabricated when the other path ran, so both are optional.
    rationale: z.string().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
    visionFallback: z.boolean(),
    origin: TurnEventOriginSchema.optional(),
  }),
  z.object({
    type: z.literal('complete'),
    state: AgentTurnStateSchema,
    status: z.enum(['completed', 'failed', 'cancelled']),
    result: z.string().optional(),
    error: z.string().optional(),
    ...AgentOptionalUsageFieldsShape,
  }),
  z.object({
    type: z.literal('ask'),
    state: AgentTurnStateSchema,
    questions: z.array(AgentTurnQuestionSchema),
    ...AgentOptionalUsageFieldsShape,
  }),
  z.object({
    type: z.literal('interrupted'),
    state: AgentTurnStateSchema,
    ...AgentOptionalUsageFieldsShape,
  }),
  z.object({
    type: z.literal('sleep'),
    state: AgentTurnStateSchema,
    wakeAt: z.number(),
    ...AgentOptionalUsageFieldsShape,
  }),
])
export type AgentTurnStartedEvent = z.infer<typeof AgentTurnStartedEventSchema>

export const AgentRpcCommandAcceptedEventSchema = z.object({
  type: z.literal('command_accepted'),
  requestId: z.string().min(1),
  commandType: z.enum(['prompt', 'answer', 'wake']),
}) satisfies z.ZodType<RpcCommandAcceptedEvent>

const AgentStoredTurnMarkerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn_started') }),
  z.object({
    type: z.literal('complete'),
    status: z.enum(['completed', 'failed', 'cancelled']).optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    ...AgentOptionalUsageFieldsShape,
  }),
  z.object({
    type: z.literal('ask'),
    status: z.literal('ask').optional(),
    questions: z.array(AgentTurnQuestionSchema),
    ...AgentOptionalUsageFieldsShape,
  }),
  z.object({
    type: z.literal('interrupted'),
    status: z.literal('interrupted').optional(),
    error: z.string().optional(),
    ...AgentOptionalUsageFieldsShape,
  }),
  z.object({
    type: z.literal('sleep'),
    status: z.literal('sleep').optional(),
    wakeAt: z.number(),
    ...AgentOptionalUsageFieldsShape,
  }),
])

export type AgentEventClass = 'canonical' | 'ephemeral' | 'doc_patch'

export function classifyAgentTurnEvent(event: AgentTurnEvent): AgentEventClass {
  switch (event.type) {
    case 'turn_started':
    case 'complete':
    case 'ask':
    case 'interrupted':
    case 'sleep':
    case 'task_started':
    case 'task_output':
    case 'task_settled':
      return 'canonical'
    case 'step':
      return classifyTurnStep(event.step)
    case 'usage':
    case 'memory':
    case 'heartbeat':
    case 'router_switch':
      return 'ephemeral'
    // Severity decides, not a list of codes. A code list is an allowlist
    // someone has to remember to extend, so every warning minted after it was
    // written is silently live-only — a reader who reloads never learns the
    // provider was retried or the context was compacted. `level` is already on
    // every system event and already means "a reader would want to know this".
    case 'system':
      return event.level === 'warn' || event.level === 'error' ? 'canonical' : 'ephemeral'
    case 'todos':
    case 'follow_up_queue':
    case 'state_machine':
      return 'doc_patch'
    default:
      return assertNever(event)
  }
}

/** Whether this event is the one that ends a turn. Only a runner authors one. */
export function isTerminalEvent(event: AgentTurnEvent): boolean {
  return (AGENT_TERMINAL_STATES as readonly string[]).includes(event.type)
}

export function isCanonicalEvent(event: AgentTurnEvent): boolean {
  return classifyAgentTurnEvent(event) === 'canonical'
}

export function isEphemeralEvent(event: AgentTurnEvent): boolean {
  return classifyAgentTurnEvent(event) === 'ephemeral'
}

function classifyTurnStep(step: TurnStep): AgentEventClass {
  switch (step.type) {
    case 'text':
    case 'reasoning':
    case 'tool_call':
    case 'system':
      return 'canonical'
    // Durable, unlike the deltas: a long tool call is what a mid-turn reader
    // is waiting on, and a transcript rebuilt from durable rows must show it
    // running rather than stopping at the last finished step. The completed
    // tool_call upserts over it by toolCallId, so history stays one card per
    // call.
    case 'tool_call_start':
      return 'canonical'
    case 'text_delta':
    case 'reasoning_delta':
      return 'ephemeral'
    default:
      return assertNever(step)
  }
}

const AgentSessionCreatedEventSchema = z.object({
  type: z.literal('session_created'),
  prompt: z.string(),
  createdAt: z.string(),
  clientRequestId: z.string().uuid().optional(),
})

const AgentInterruptRequestedEventSchema = z.object({
  type: z.literal('interrupt_requested'),
  requestedAt: z.string(),
})

/**
 * A message authored by the agent outside any turn. Today the only writer is
 * session creation materializing the agent's suggested first message (map
 * D1-D3): it lands between `session_created` and the first `prompt_submitted`
 * so the transcript opens in the agent's voice. Not an input event — the
 * runner never receives it as a deliverable; the first envelope quotes it
 * instead.
 */
const AgentMessageEventSchema = z.object({
  type: z.literal('agent_message'),
  message: z.string().min(1),
  createdAt: z.string(),
})

/**
 * What one relayed turn event may weigh once the control plane stores it.
 *
 * Convex refuses a document over 1 MiB, and an event it refuses can never be
 * relayed — it holds the head of the journal forever and every event behind it
 * with it (2026-08-17). The budget sits well under that ceiling because the
 * timeline is a reading surface, not an archive: the agent's own view of a
 * result and the durable checkpoint keep the full text either way.
 *
 * It lives in the contract rather than in the gateway that enforces it because
 * it is also a ceiling on things the gateway never sees. This whole-event
 * safety ceiling is separate from the gateway's much smaller tool-output
 * preview budget. The human timeline can be truncated even when the agent
 * retains the complete result locally.
 */
export const CONVEX_EVENT_BUDGET_BYTES = 300 * 1024

export const AGENT_INPUT_IMAGE_MAX_COUNT = 4
export const AGENT_INPUT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const AGENT_INPUT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

const AgentImageMimeTypeSchema = z.enum(AGENT_INPUT_IMAGE_MIME_TYPES)

export const AgentInputImageSchema = z.object({
  data: z
    .string()
    .min(1)
    .superRefine((data, ctx) => {
      const bytes = base64DecodedByteLength(data)
      if (bytes === null) {
        ctx.addIssue({ code: 'custom', message: 'Invalid base64 image data' })
        return
      }
      if (bytes > AGENT_INPUT_IMAGE_MAX_BYTES) {
        ctx.addIssue({ code: 'custom', message: 'Image exceeds maximum size' })
      }
    }),
  mimeType: AgentImageMimeTypeSchema,
})
export type AgentInputImage = z.infer<typeof AgentInputImageSchema>

const AgentInputImagesSchema = z
  .array(AgentInputImageSchema)
  .max(AGENT_INPUT_IMAGE_MAX_COUNT)
  .optional()

export const AgentEventImageSchema = z.object({
  storageId: z.string().min(1),
  mimeType: AgentImageMimeTypeSchema,
  bytes: z.number().int().min(0).max(AGENT_INPUT_IMAGE_MAX_BYTES),
})
export type AgentEventImage = z.infer<typeof AgentEventImageSchema>

const AgentEventImagesSchema = z
  .array(AgentEventImageSchema)
  .max(AGENT_INPUT_IMAGE_MAX_COUNT)
  .optional()
const AgentEventAttachmentsSchema = z
  .array(AgentEventAttachmentSchema)
  .max(AGENT_INPUT_ATTACHMENT_MAX_COUNT)
  .optional()
const AgentRunnerDeliveryImagesSchema = z
  .array(AgentEventImageSchema)
  .max(AGENT_INPUT_IMAGE_MAX_COUNT)

// The one identity-only author union for durable session input. IDs only:
// names, emails, slugs, and titles are resolved at read time by their owners
// (backend delivery for model bytes, the browser for transcript labels).
export const SessionInputSenderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1) }),
  z.object({ kind: z.literal('app'), appId: z.string().min(1) }),
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({ kind: z.literal('system') }),
])
export type SessionInputSender = z.infer<typeof SessionInputSenderSchema>

// Two inputs share an author when their senders name the same identity.
// Compared by value: idempotent replays (Convex) and optimistic frames (web)
// both rebuild the sender independently of the stored row.
export function isSameInputSender(left: SessionInputSender, right: SessionInputSender): boolean {
  switch (left.kind) {
    case 'user':
      return right.kind === 'user' && left.userId === right.userId
    case 'app':
      return right.kind === 'app' && left.appId === right.appId
    case 'session':
      return right.kind === 'session' && left.sessionId === right.sessionId
    case 'system':
      return right.kind === 'system'
  }
}

export const AgentPromptSubmittedEventSchema = z.object({
  type: z.literal('prompt_submitted'),
  prompt: z.string(),
  inputKind: z.enum(['initial', 'message']),
  behavior: AgentPromptBehaviorSchema,
  sender: SessionInputSenderSchema,
  clientRequestId: z.string().uuid().optional(),
  images: AgentEventImagesSchema,
  attachments: AgentEventAttachmentsSchema,
})

export const AgentNoteSubmittedEventSchema = z.object({
  type: z.literal('note_submitted'),
  note: z.string(),
  sender: SessionInputSenderSchema,
  clientRequestId: z.string().uuid().optional(),
  images: AgentEventImagesSchema,
  attachments: AgentEventAttachmentsSchema,
})

export const AgentAnswerSubmittedEventSchema = z.object({
  type: z.literal('answer_submitted'),
  answer: z.string(),
  sender: SessionInputSenderSchema,
  clientRequestId: z.string().uuid().optional(),
  images: AgentEventImagesSchema,
  attachments: AgentEventAttachmentsSchema,
})

const AgentInputEventSchema = z.discriminatedUnion('type', [
  AgentPromptSubmittedEventSchema,
  AgentNoteSubmittedEventSchema,
  AgentAnswerSubmittedEventSchema,
])
export type AgentInputEvent = z.infer<typeof AgentInputEventSchema>

export const AGENT_SESSION_EVENT_TYPES = [
  'turn_started',
  'step',
  'task_started',
  'task_output',
  'task_settled',
  'heartbeat',
  'todos',
  'follow_up_queue',
  'state_machine',
  'memory',
  'usage',
  'system',
  'router_switch',
  'complete',
  'ask',
  'interrupted',
  'sleep',
  'session_created',
  'interrupt_requested',
  'agent_message',
  'prompt_submitted',
  'note_submitted',
  'answer_submitted',
] as const

export const AgentSessionTimelineEventSchema = z.union([
  AgentTurnEventSchema,
  AgentStoredTurnMarkerEventSchema,
  AgentSessionCreatedEventSchema,
  AgentInterruptRequestedEventSchema,
  AgentMessageEventSchema,
  AgentInputEventSchema,
])
export type AgentSessionTimelineEvent = z.infer<typeof AgentSessionTimelineEventSchema>

/* Tolerant on read (map D10): a bundle must survive event types minted after
   it shipped. The read union ends in this catch-all, so an unknown event
   parses opaquely instead of failing the whole history response; readers gate
   on `isKnownTimelineEvent` and skip the rest. Deliberately a union member
   rather than a `.transform()` — the endpoint docs render these schemas as
   JSON Schema, which transforms cannot survive. The write side (`appendEvent`)
   parses the strict union above. */
export const UnknownAgentSessionEventSchema = z.looseObject({ type: z.string() })
export type UnknownAgentSessionEvent = z.infer<typeof UnknownAgentSessionEventSchema>

export const AgentSessionTimelineEventReadSchema = z.union([
  AgentSessionTimelineEventSchema,
  UnknownAgentSessionEventSchema,
])
export type AgentSessionTimelineEventRead = z.infer<typeof AgentSessionTimelineEventReadSchema>

const KNOWN_TIMELINE_EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_SESSION_EVENT_TYPES)

export function isKnownTimelineEvent(
  event: AgentSessionTimelineEventRead,
): event is AgentSessionTimelineEvent {
  return KNOWN_TIMELINE_EVENT_TYPES.has(event.type)
}

export const RUNNER_DELIVERY_KINDS = ['initial_prompt', 'message', 'answer'] as const

export const RunnerDeliveryAttemptSchema = z.object({
  attemptId: z.string().min(1),
  throughSeq: z.number().int().min(0),
  kind: z.enum(RUNNER_DELIVERY_KINDS),
  createdAt: z.number(),
})
export type RunnerDeliveryAttempt = z.infer<typeof RunnerDeliveryAttemptSchema>

export function isRunnerDeliverableInputEvent(
  event: AgentSessionTimelineEvent,
): event is AgentInputEvent {
  return (
    event.type === 'prompt_submitted' ||
    event.type === 'note_submitted' ||
    event.type === 'answer_submitted'
  )
}

/**
 * Whether a timeline row is transcript: something the session's reader sees.
 * Tasks are duet-agent's structured-concurrency rail, and a step that names an
 * origin task is a child's work; both are runtime plumbing that would only
 * duplicate the public tool call owning the operation. The history index pages
 * by this stamp and the projection drops by it.
 */
export function isTranscriptEvent(event: AgentSessionTimelineEvent): boolean {
  if (
    event.type === 'task_started' ||
    event.type === 'task_output' ||
    event.type === 'task_settled'
  ) {
    return false
  }
  return !(event.type === 'step' && event.origin !== undefined)
}

export function collectRunnerImages(args: {
  notes: Array<{ images?: AgentEventImage[] }>
  input: { images?: AgentEventImage[] }
}): AgentEventImage[] {
  const inputImages = args.input.images ?? []
  const remainingNoteSlots = Math.max(0, AGENT_INPUT_IMAGE_MAX_COUNT - inputImages.length)
  return AgentRunnerDeliveryImagesSchema.parse(
    [
      ...inputImages,
      ...args.notes.flatMap(note => note.images ?? []).slice(0, remainingNoteSlots),
    ].slice(0, AGENT_INPUT_IMAGE_MAX_COUNT),
  )
}

/**
 * An input is empty only when it has neither words nor media. A file sent on
 * its own is a whole message — the runner envelope names every attachment to
 * the model — so text is one way to say something, not a requirement.
 */
const INPUT_TEXT_DESCRIPTION =
  'The words of the input. May be empty when it carries images or attachments.'

function inputCarriesContent(
  text: string,
  input: { images?: readonly unknown[]; attachments?: readonly unknown[] },
): boolean {
  return (
    text.trim().length > 0 ||
    (input.images?.length ?? 0) > 0 ||
    (input.attachments?.length ?? 0) > 0
  )
}

const agentStartSessionRequestFields = {
  prompt: z.string().describe(INPUT_TEXT_DESCRIPTION),
  clientRequestId: z.string().uuid().optional(),
  cwd: AgentCwdSchema.optional(),
  images: AgentInputImagesSchema,
  attachments: AgentEventAttachmentsSchema,
  tier: ModelSelectionIdSchema.optional(),
  behavior: AgentPromptBehaviorSchema.default('steer'),
  mode: AgentStateMachineDefinitionSchema.optional().refine(scheduleFloorHolds, {
    message: 'schedule_below_minimum',
  }),
}

export const SessionCreationAudienceInputSchema = z
  .object({
    kind: z.literal('specific'),
    memberUserIds: z.array(z.string()).max(WORKSPACE_MEMBER_LIMIT),
  })
  .strict()
export type SessionCreationAudienceInput = z.infer<typeof SessionCreationAudienceInputSchema>

// Creation transports are deliberately strict. Ordinary and nested creation
// have different policy even while most of their fields coincide: only the
// ordinary schema may grow an audience input, while nested creation always
// inherits its parent. Keeping separate objects makes that boundary visible to
// endpoint docs and prevents Zod's default unknown-key stripping from turning
// a forbidden audience override into a successful request.
export const AgentStartSessionRequestSchema = z
  .object({
    ...agentStartSessionRequestFields,
    audience: SessionCreationAudienceInputSchema.optional(),
  })
  .strict()
  .refine(input => inputCarriesContent(input.prompt, input), {
    message: 'empty_input',
    path: ['prompt'],
  })
export type AgentStartSessionRequestInput = z.input<typeof AgentStartSessionRequestSchema>
export type AgentStartSessionRequest = z.output<typeof AgentStartSessionRequestSchema>

export const AgentStartSessionWaitRequestSchema = AgentStartSessionRequestSchema.safeExtend({
  clientRequestId: z.string().uuid(),
})
export type AgentStartSessionWaitRequest = z.infer<typeof AgentStartSessionWaitRequestSchema>

export const AgentStartNestedSessionRequestSchema = z
  .object(agentStartSessionRequestFields)
  .strict()
  .refine(input => inputCarriesContent(input.prompt, input), {
    message: 'empty_input',
    path: ['prompt'],
  })
export type AgentStartNestedSessionRequest = z.infer<typeof AgentStartNestedSessionRequestSchema>

export const AgentStartNestedSessionWaitRequestSchema =
  AgentStartNestedSessionRequestSchema.safeExtend({
    clientRequestId: z.string().uuid(),
  })
export type AgentStartNestedSessionWaitRequest = z.infer<
  typeof AgentStartNestedSessionWaitRequestSchema
>

// A public caller may name a source session as the input's author; every other
// sender is derived by the API from the authenticated credential or route.
const SourceSessionIdSchema = z.string().min(1)

export const AgentMessageRequestSchema = z
  .object({
    prompt: z.string().describe(INPUT_TEXT_DESCRIPTION),
    clientRequestId: z.string().uuid().optional(),
    images: AgentInputImagesSchema,
    attachments: AgentEventAttachmentsSchema,
    tier: ModelSelectionIdSchema.optional(),
    behavior: AgentPromptBehaviorSchema.default('steer'),
    sourceSessionId: SourceSessionIdSchema.optional(),
  })
  .refine(input => inputCarriesContent(input.prompt, input), {
    message: 'empty_input',
    path: ['prompt'],
  })
export type AgentMessageRequestInput = z.input<typeof AgentMessageRequestSchema>
export type AgentMessageRequest = z.output<typeof AgentMessageRequestSchema>

export const AgentMessageWaitRequestSchema = AgentMessageRequestSchema.safeExtend({
  clientRequestId: z.string().uuid(),
})
export type AgentMessageWaitRequest = z.infer<typeof AgentMessageWaitRequestSchema>

export const AgentNoteRequestSchema = z
  .object({
    note: z
      .string()
      .max(16 * 1024)
      .describe(INPUT_TEXT_DESCRIPTION),
    clientRequestId: z.string().uuid().optional(),
    images: AgentInputImagesSchema,
    attachments: AgentEventAttachmentsSchema,
    sourceSessionId: SourceSessionIdSchema.optional(),
  })
  .refine(input => inputCarriesContent(input.note, input), {
    message: 'empty_input',
    path: ['note'],
  })
export type AgentNoteRequest = z.infer<typeof AgentNoteRequestSchema>

export const AgentAnswerRequestSchema = z
  .object({
    answer: z.string().describe(INPUT_TEXT_DESCRIPTION),
    clientRequestId: z.string().uuid().optional(),
    images: AgentInputImagesSchema,
    attachments: AgentEventAttachmentsSchema,
    sourceSessionId: SourceSessionIdSchema.optional(),
  })
  .refine(input => inputCarriesContent(input.answer, input), {
    message: 'empty_input',
    path: ['answer'],
  })
export type AgentAnswerRequest = z.infer<typeof AgentAnswerRequestSchema>

export const AgentAnswerWaitRequestSchema = AgentAnswerRequestSchema.safeExtend({
  clientRequestId: z.string().uuid(),
})
export type AgentAnswerWaitRequest = z.infer<typeof AgentAnswerWaitRequestSchema>

export const IntegrationTurnLaunchSchema = z.literal(true)
export type IntegrationTurnLaunch = z.infer<typeof IntegrationTurnLaunchSchema>

/**
 * The custom MCP servers this turn gets, by name only.
 *
 * Names, not URLs or credentials: the gateway builds the proxy URL and attaches
 * the workspace's own Duet bearer, so no third-party address and no third-party
 * secret ever crosses onto the VM. The marker is persisted to the VM's disk in
 * the ledger envelope, which is the same reason nothing that goes stale badly
 * may ride on it either.
 *
 * An array of objects rather than `string[]` so a later per-server field can
 * ride along without a second wire change. It costs nothing today.
 */
export const McpServerTurnLaunchSchema = z
  .array(z.object({ name: McpServerNameSchema }).loose())
  .max(MAX_MCP_SERVERS_PER_WORKSPACE)
export type McpServerTurnLaunch = z.infer<typeof McpServerTurnLaunchSchema>

export const GatewaySessionIntegrationsRefreshResponseSchema = z
  .object({
    integrations: IntegrationTurnLaunchSchema.optional(),
    mcpServers: McpServerTurnLaunchSchema.optional(),
  })
  .loose()
export type GatewaySessionIntegrationsRefreshResponse = z.infer<
  typeof GatewaySessionIntegrationsRefreshResponseSchema
>

export const GatewayRunnerInputRequestSchema = z
  .object({
    attemptId: z.string().min(1),
    throughSeq: z.number().int().nonnegative(),
    input: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('prompt'),
        message: z.string().min(1),
        behavior: AgentPromptBehaviorSchema,
        images: AgentInputImagesSchema,
      }),
      z.object({
        kind: z.literal('answer'),
        answer: z.string().min(1),
        images: AgentInputImagesSchema,
      }),
    ]),
    launch: z
      .object({
        cwd: AgentCwdSchema.optional(),
        tier: ModelSelectionIdSchema,
        // Onboarding sessions run under the agent's ONBOARDING.md instead of its
        // AGENTS.md, with any forced mode suppressed. The API re-projects this
        // from the durable session row on every dispatch, so a resumed or woken
        // session cannot drift back to the ordinary prompt.
        onboarding: z.boolean().optional(),
        mode: AgentStateMachineDefinitionSchema.optional(),
        createdBySessionId: z.string().optional(),
        defaultSession: z.literal(true).optional(),
        integrations: IntegrationTurnLaunchSchema.optional(),
        mcpServers: McpServerTurnLaunchSchema.optional(),
      })
      // Launch data is persisted and forwarded across version-skewed gateway readers.
      .loose(),
  })
  // The runner input wire is forwarded across independently deployed API and gateway versions.
  .loose()
export type GatewayRunnerInputRequest = z.infer<typeof GatewayRunnerInputRequestSchema>

export const GatewaySessionCwdRequestSchema = z.object({ cwd: AgentCwdSchema }).loose()
export type GatewaySessionCwdRequest = z.infer<typeof GatewaySessionCwdRequestSchema>

export const GatewaySessionCwdReceiptSchema = z.object({ cwd: AgentCwdSchema }).loose()
export type GatewaySessionCwdReceipt = z.infer<typeof GatewaySessionCwdReceiptSchema>

export const GatewaySessionDiscardReceiptSchema = z
  .object({ ok: z.literal(true), discarded: z.boolean() })
  .loose()
export type GatewaySessionDiscardReceipt = z.infer<typeof GatewaySessionDiscardReceiptSchema>

/**
 * `interrupted` answers whether a RUNNER took the stop and reached its
 * terminal, not whether the gateway understood the request. Anything else —
 * no runner, a hydration that could not spawn, a body that does not parse —
 * is a stop the VM did not carry out, and the control plane ends the turn.
 */
export const GatewaySessionInterruptReceiptSchema = z.object({ interrupted: z.boolean() }).loose()
export type GatewaySessionInterruptReceipt = z.infer<typeof GatewaySessionInterruptReceiptSchema>

export const GatewayRunnerInputReceiptSchema = z.object({
  acceptedThroughSeq: z.number().int().nonnegative(),
  disposition: z.enum(['live', 'hydrated', 'duplicate', 'settled']),
})

export type GatewayRunnerInputReceipt = z.infer<typeof GatewayRunnerInputReceiptSchema>

export const InterruptedCheckpointTargetSchema = z.object({
  expectedLastEventSeq: z.number().int().nonnegative(),
  acceptedThroughSeq: z.number().int().nonnegative(),
})

export const AgentVmRelayEventRequestSchema = z.object({
  relayId: z.string().min(1),
  event: AgentTurnEventSchema,
  acceptedThroughSeq: z.number().int().nonnegative().optional(),
})

export const McpRunAgentInputSchema = z.object({
  workspace: WorkspaceSlugSchema,
  prompt: z.string().min(1),
  images: AgentInputImagesSchema,
})

function base64DecodedByteLength(data: string): number | null {
  if (data.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  if (padding > 0 && data.slice(0, -padding).includes('=')) return null
  return (data.length / 4) * 3 - padding
}

function assertNever(value: never): never {
  throw new Error(`Unhandled agent event member: ${JSON.stringify(value)}`)
}
