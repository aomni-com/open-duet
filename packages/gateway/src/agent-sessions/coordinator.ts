import { randomUUID } from 'node:crypto'

import {
  AgentVmRelayEventRequestSchema,
  InterruptedCheckpointTargetSchema,
  AgentTurnEventSchema,
  classifyAgentTurnEvent,
  type AgentTurnCommand,
  type AgentTurnEvent,
  type BrowserOwner,
  type GatewayRunnerInputReceipt,
  type GatewayRunnerInputRequest,
  type GatewaySessionCwdReceipt,
  type GatewaySessionIntegrationsRefreshResponse,
  type GatewayAnchor,
  type GatewayAgentConfig,
  type GatewayAppConfig,
  type McpServersConfig,
  type ModelSelectionId,
  BOUND_AGENT_ROOT_UNAVAILABLE,
  RELAY_BACKLOG_TERMINAL,
  isTerminalEvent,
  RELAY_UNDELIVERABLE_TERMINAL,
  RUNNER_EXITED_TERMINAL,
  SESSION_CWD_FALLBACK,
  STORAGE_FULL_ERROR,
} from '@repo/contract'

import { defaultAgentContext, resolveBound, resolveFresh } from '../agents/agent-context'
import { placeRunnerInCgroup, removeRunnerCgroupWhenDrained } from '../runner/cgroup'
import {
  defaultRunnerFactory,
  RunnerUnresponsiveError,
  type AgentRunner,
  type AgentRunnerFactory,
} from '../runner/process-runner'
import type { AgentRunnerCommand } from '../runner/protocol'
import {
  RingSessionEventBuffer,
  type SessionEventBuffer,
  type SessionEventSubscription,
} from '../runner/session-event-buffer'
import type { DiskGuard } from '../vm/disk-guard'
import {
  AgentRelayOutboxCapacityError,
  AGENT_RELAY_OUTBOX_LIMITS,
  AgentSessionEnvelopeQuarantinedError,
  createAgentSessionLedger,
  mergeGatewaySessionLaunch,
  type AgentSessionLedger,
  type GatewaySessionEnvelope,
  type GatewaySessionState,
} from './ledger'
import { resolveSpawnCwd, type SpawnCwdFallbackReason, type SpawnCwdResolution } from './spawn-cwd'
import { storableEvent } from './storable-event'

export type { AgentRunnerFactory } from '../runner/process-runner'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AgentRelayResult {
  seq: number | null
}

export type AgentRelayEvent = (
  sessionId: string,
  relayId: string,
  event: AgentTurnEvent,
  acceptedThroughSeq?: number,
) => Promise<AgentRelayResult | void>

export interface RunnerCgroupHooks {
  place(pid: number, sessionId: string): Promise<void>
  removeWhenDrained(sessionId: string): Promise<void>
}

export interface AgentSessionsControllerOptions {
  log?: (fields: Record<string, unknown>) => void
  apiUrl?: string
  stateDir: string
  driveDir: string
  memoryDbPath: string
  anchors?: () => readonly GatewayAnchor[]
  apps?: () => readonly GatewayAppConfig[]
  /** `undefined` while no roster has arrived — never flatten it to an empty one. */
  agents?: () => readonly GatewayAgentConfig[] | undefined
  workspaceSlug?: () => string | undefined
  getVmToken: () => Promise<string | null>
  fetch?: FetchLike
  runnerFactory?: AgentRunnerFactory
  relayEvent?: AgentRelayEvent
  modelEnv?: () => Record<string, string> | null
  mcpServers?: (
    sessionId: string,
    launch: GatewaySessionEnvelope['launch'],
  ) => McpServersConfig | null
  /**
   * Re-asks the control plane which MCP servers this turn gets, for a wake that
   * has no request behind it. One call answers both kinds; either half may come
   * back unanswered without taking the other down with it.
   */
  refreshTurnMcp?: (
    sessionId: string,
  ) => Promise<GatewaySessionIntegrationsRefreshResponse | undefined>
  ensureRunner?: () => Promise<void>
  cgroup?: RunnerCgroupHooks
  now?: () => number
  createRequestId?: () => string
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  isQuiesced?: () => boolean
  diskGuard?: DiskGuard
  relayOutboxLimits?: { maxBytes: number }
}

export interface AgentSessionsController {
  deliverInput(
    sessionId: string,
    args: GatewayRunnerInputRequest,
  ): Promise<GatewayRunnerInputReceipt>
  discard(sessionId: string): Promise<boolean>
  discardAgent(agentAnchorId: string): Promise<string[]>
  interrupt(sessionId: string): Promise<boolean>
  setCwd(sessionId: string, cwd: string): Promise<GatewaySessionCwdReceipt>
  setQuiesced(quiesced: boolean): void
  setStartsBlocked(blocked: boolean): void
  subscribeToEvents(sessionId: string, sinceSeq: number): SessionEventSubscription
  has(sessionId: string): boolean
  activeCount(): number
  activeSessionIds(): string[]
  browserOwnerForSession(sessionId: string): Promise<BrowserOwnerResolution>
}

export type BrowserOwnerResolution =
  | { ok: true; owner: BrowserOwner }
  | {
      ok: false
      error: 'browser_session_not_found' | 'browser_owner_unavailable'
    }

export class AgentSessionCwdError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_cwd',
    readonly reason?: SpawnCwdFallbackReason,
  ) {
    super(code)
  }
}

/**
 * The session's envelope is permanently gone — the agent was deleted, or it
 * was explicitly torn down. Distinct from every other delivery failure: a
 * discarded envelope refuses writes (`ledger.ts`'s tombstone fence), so
 * nothing can ever be settled into it, and a caller must stop retrying
 * rather than treat this as transient.
 */
export class AgentSessionDiscardedError extends Error {
  constructor(sessionId: string) {
    super(`Agent session discarded: ${sessionId}`)
  }
}

export function createAgentSessionsController(
  options: AgentSessionsControllerOptions,
): AgentSessionsController {
  return new AgentSessionCoordinator(options)
}

const MAX_SESSION_BUFFERS = 256
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_MS = 5_000
// A runner computes its wake time on this VM's clock moments before the sleep
// lands, so a legitimate wake trails now by pipe latency at most.
const STALE_WAKE_GRACE_MS = 5_000
// Retrying is how the relay survives a deploy, a restart, or a control plane
// having a bad minute, so the give-up has to sit well past any of those: at one
// attempt per DEFAULT_RETRY_MS this is upwards of five minutes of uninterrupted
// refusal. Past that the payload is the problem, not the weather, and retrying
// it forever costs the whole session rather than one event.
const MAX_RELAY_ATTEMPTS = 60
const MAX_TIMER_DELAY_MS = 2_147_483_647
const QUIESCE_COHORT_SIZE = 4

interface TerminalWaiter {
  type: 'interrupted'
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class AgentSessionCoordinator implements AgentSessionsController {
  private readonly runners = new Map<string, AgentRunner>()
  private readonly buffers = new Map<string, SessionEventBuffer>()
  private readonly relayFailures = new Map<string, { relayId: string; attempts: number }>()
  private readonly sessionTails = new Map<string, Promise<void>>()
  private readonly terminalWaiters = new Map<string, Set<TerminalWaiter>>()
  private readonly wakeTimers = new Map<string, { generation: number; timer: unknown }>()
  private readonly relayRetryTimers = new Map<string, unknown>()
  private readonly recoveryRetryTimers = new Map<string, unknown>()
  private readonly recoveryRetryAttempts = new Map<string, number>()
  private readonly quarantinedSessions = new Set<string>()
  private readonly relayOverloadedSessions = new Set<string>()
  private readonly relay: AgentRelayEvent
  private readonly fetchImpl: FetchLike
  private readonly factory: AgentRunnerFactory
  private readonly cgroup: RunnerCgroupHooks
  private readonly ledger: AgentSessionLedger
  private readonly ready: Promise<void>
  private readonly launchingSessions = new Set<string>()
  private startsBlocked = false
  private quiesceGeneration = 0
  private projectedQuiesced: boolean
  private quiesceSweep: Promise<void> | null = null
  private quiesceRetryTimer: unknown | null = null

  constructor(private readonly options: AgentSessionsControllerOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.relay =
      options.relayEvent ??
      ((sessionId, relayId, event, acceptedThroughSeq) =>
        this.relayToApi(sessionId, relayId, event, acceptedThroughSeq))
    this.factory = options.runnerFactory ?? (args => defaultRunnerFactory(args, options.driveDir))
    this.cgroup = options.cgroup ?? {
      place: placeRunnerInCgroup,
      removeWhenDrained: removeRunnerCgroupWhenDrained,
    }
    this.ledger = createAgentSessionLedger({
      stateDir: options.stateDir,
      now: options.now ?? Date.now,
      relayOutboxLimits: options.relayOutboxLimits,
    })
    this.projectedQuiesced = this.isQuiesced()
    this.ready = this.restoreWakeSchedules()
    void this.ready.then(() => {
      if (this.isQuiesced()) this.startQuiesceSweep()
    })
  }

  async deliverInput(
    sessionId: string,
    args: GatewayRunnerInputRequest,
  ): Promise<GatewayRunnerInputReceipt> {
    await this.ready
    return this.withSession(sessionId, () => this.deliverInputUnclaimed(sessionId, args))
  }

  async browserOwnerForSession(sessionId: string): Promise<BrowserOwnerResolution> {
    await this.ready
    if (await this.ledger.isDiscarded(sessionId)) {
      return { ok: false, error: 'browser_session_not_found' }
    }
    const envelope = await this.ledger.read(sessionId)
    if (envelope === null) return { ok: false, error: 'browser_session_not_found' }
    if (envelope.agentAnchorId === undefined) return { ok: true, owner: { kind: 'root' } }

    const anchor = (this.options.anchors?.() ?? []).find(
      candidate => candidate.id === envelope.agentAnchorId,
    )
    if (anchor?.agentId === undefined || anchor.agentId.length === 0) {
      return { ok: false, error: 'browser_owner_unavailable' }
    }
    return { ok: true, owner: { kind: 'agent', agentId: anchor.agentId } }
  }

  private async deliverInputUnclaimed(
    sessionId: string,
    args: GatewayRunnerInputRequest,
  ): Promise<GatewayRunnerInputReceipt> {
    if (this.quarantinedSessions.delete(sessionId)) {
      throw new AgentSessionEnvelopeQuarantinedError(sessionId)
    }
    if (await this.ledger.isDiscarded(sessionId)) throw new AgentSessionDiscardedError(sessionId)
    const persisted = await this.ledger.read(sessionId)
    if (persisted !== null && args.throughSeq <= persisted.acceptedThroughSeq) {
      return {
        acceptedThroughSeq: persisted.acceptedThroughSeq,
        disposition: 'duplicate',
      }
    }
    const requestId = args.attemptId
    const envelope = persisted ?? (await this.ensureSessionEnvelope(sessionId, args.launch))
    // A live runner here is always a turn actually running — every terminal
    // event (including `ask`) kills its runner, so answers and post-ask
    // messages take the no-runner hydration path below. A running turn is
    // never refused (D14): its inputs flow untouched.
    const existing = this.runners.get(sessionId)
    if (existing !== undefined) {
      if (existing.isAlive()) {
        await this.sendOrReap(sessionId, existing, runnerPromptCommand(args, requestId))
        const accepted = await this.acceptInput(sessionId, args.launch, args, requestId)
        await this.recordAcceptedInputActivity(sessionId)
        return { acceptedThroughSeq: accepted.acceptedThroughSeq, disposition: 'live' }
      }
      this.runners.delete(sessionId)
    }
    if ((await this.options.diskGuard?.ensureWritable()) === 'full') {
      const settled = await this.ledger.settleInput({
        sessionId,
        launch: args.launch,
        throughSeq: args.throughSeq,
        event: storageFullEvent(),
      })
      await this.drainRelayOutbox(sessionId, this.bufferFor(sessionId))
      await this.recordAcceptedInputActivity(sessionId)
      return { acceptedThroughSeq: settled.acceptedThroughSeq, disposition: 'settled' }
    }
    const launch = mergeGatewaySessionLaunch(envelope, args.launch)
    const spawnCwd = resolveSpawnCwd({
      driveDir: this.options.driveDir,
      requestedCwd: launch.cwd,
      anchors: this.options.anchors?.() ?? [],
      agentAnchorId: envelope.agentAnchorId,
    })
    if (spawnCwd.terminal !== undefined) {
      const settled = await this.ledger.settleInput({
        sessionId,
        launch,
        throughSeq: args.throughSeq,
        event: boundAgentRootUnavailableEvent(),
      })
      await this.drainRelayOutbox(sessionId, this.bufferFor(sessionId))
      await this.recordAcceptedInputActivity(sessionId)
      return { acceptedThroughSeq: settled.acceptedThroughSeq, disposition: 'settled' }
    }
    const runner = await this.launchRunner({
      sessionId,
      envelope: { ...envelope, launch },
      lastEventSeq: args.throughSeq,
      cwd: launch.cwd,
      tier: launch.tier,
      spawnCwd,
    })
    await this.sendOrReap(sessionId, runner, runnerPromptCommand(args, requestId))
    const accepted = await this.acceptInput(sessionId, args.launch, args, requestId)
    await this.recordAcceptedInputActivity(sessionId)
    return { acceptedThroughSeq: accepted.acceptedThroughSeq, disposition: 'hydrated' }
  }

  /**
   * Deliver a command the turn cannot proceed without. A runner that never
   * acknowledges it is alive but not reading its RPC, and nothing it is
   * doing can finish without the loop that would have read it — so waiting
   * longer gains nothing, and leaving it means a session that reads as
   * running until someone presses stop. Reap it the way a crash is reaped,
   * so the control plane ends the turn and its retry of this same input
   * hydrates a fresh runner from the checkpoint. The refusal still
   * propagates: the caller's 503 is what makes that retry happen.
   */
  private async sendOrReap(
    sessionId: string,
    runner: AgentRunner,
    command: AgentRunnerCommand,
  ): Promise<void> {
    try {
      await runner.send(command)
    } catch (error) {
      if (!(error instanceof RunnerUnresponsiveError)) throw error
      this.discardRunner(sessionId, runner, error)
      this.options.log?.({
        event: 'runner_unresponsive',
        sessionId,
        commandType: error.commandType,
        stderr: runner.getStderr(),
      })
      // Queued behind this delivery's own session lock, like the exit hook.
      void this.reportGatewayEndedTurn(
        sessionId,
        this.bufferFor(sessionId),
        runnerExitedEvent('This turn stopped: the agent stopped responding and was shut down.'),
        'runner unresponsive',
      )
      throw error
    }
  }

  /**
   * Forget a runner and end its process. Deleting it from the map first is
   * what keeps the exit hook from reporting a death the coordinator caused.
   */
  private discardRunner(sessionId: string, runner: AgentRunner, error: unknown): void {
    if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId)
    runner.kill()
    this.rejectTerminalWaiters(sessionId, error)
  }

  private async ensureSessionEnvelope(
    sessionId: string,
    launch: GatewayRunnerInputRequest['launch'],
  ): Promise<GatewaySessionEnvelope> {
    const existing = await this.ledger.read(sessionId)
    if (existing !== null) return existing
    const context =
      this.options.anchors === undefined
        ? null
        : resolveFresh({
            cwd: launch.cwd,
            onboarding: launch.onboarding,
            driveDir: this.options.driveDir,
            stateDir: this.options.stateDir,
            defaultMemoryDbPath: this.options.memoryDbPath,
            anchors: this.options.anchors(),
          })
    if (launch.onboarding === true && context?.anchorId === undefined) {
      throw new Error('Onboarding launch has no agent anchor yet')
    }
    const created: GatewaySessionEnvelope = {
      version: 1,
      sessionId,
      ...(context?.anchorId === undefined ? {} : { agentAnchorId: context.anchorId }),
      launch: { ...launch },
      acceptedThroughSeq: 0,
      inFlightCommands: [],
      relayOutbox: [],
      updatedAt: (this.options.now ?? Date.now)(),
    }
    await this.ledger.write(created)
    return created
  }

  private async acceptInput(
    sessionId: string,
    launch: GatewaySessionEnvelope['launch'],
    args: GatewayRunnerInputRequest,
    requestId: string,
  ): Promise<GatewaySessionEnvelope> {
    return this.ledger.acceptCommand({
      sessionId,
      launch,
      requestId,
      throughSeq: args.throughSeq,
      command: durablePromptCommand(args),
    })
  }

  private async launchRunner(args: {
    sessionId: string
    envelope: GatewaySessionEnvelope
    lastEventSeq: number
    cwd?: string
    tier: ModelSelectionId
    spawnCwd?: SpawnCwdResolution
  }): Promise<AgentRunner> {
    if (this.isLaunchBlocked()) {
      throw new Error('Agent runner starts are blocked')
    }
    this.launchingSessions.add(args.sessionId)
    try {
      return await this.launchRunnerUnblocked(args)
    } finally {
      this.launchingSessions.delete(args.sessionId)
    }
  }

  private async launchRunnerUnblocked(args: {
    sessionId: string
    envelope: GatewaySessionEnvelope
    lastEventSeq: number
    cwd?: string
    tier: ModelSelectionId
    spawnCwd?: SpawnCwdResolution
  }): Promise<AgentRunner> {
    const anchors = this.options.anchors?.() ?? []
    const spawnCwd =
      args.spawnCwd ??
      resolveSpawnCwd({
        driveDir: this.options.driveDir,
        requestedCwd: args.cwd,
        anchors,
        agentAnchorId: args.envelope.agentAnchorId,
      })
    if (spawnCwd.terminal !== undefined) {
      throw new Error(BOUND_AGENT_ROOT_UNAVAILABLE)
    }
    const context =
      this.options.anchors === undefined
        ? defaultAgentContext({
            driveDir: this.options.driveDir,
            stateDir: this.options.stateDir,
            defaultMemoryDbPath: this.options.memoryDbPath,
            onboarding: args.envelope.launch.onboarding,
            defaultSession: args.envelope.launch.defaultSession,
            createdBySessionId: args.envelope.launch.createdBySessionId,
            apps: this.options.apps,
            agents: this.options.agents,
            workspaceSlug: this.options.workspaceSlug,
          })
        : resolveBound(
            {
              cwd: spawnCwd.cwd,
              onboarding: args.envelope.launch.onboarding,
              defaultSession: args.envelope.launch.defaultSession,
              createdBySessionId: args.envelope.launch.createdBySessionId,
              driveDir: this.options.driveDir,
              stateDir: this.options.stateDir,
              defaultMemoryDbPath: this.options.memoryDbPath,
              anchors,
              apps: this.options.apps,
              agents: this.options.agents,
              workspaceSlug: this.options.workspaceSlug,
            },
            args.envelope.agentAnchorId,
          )
    const buffer = this.bufferFor(args.sessionId)
    buffer.resetForTurn(args.lastEventSeq)
    if (spawnCwd.fallback !== undefined) {
      await this.ledger.recordDurableSystemEvent(
        args.sessionId,
        spawnCwdFallbackEvent(spawnCwd.fallback),
      )
      void this.drainRelayOutbox(args.sessionId, buffer)
    }
    // QUEUE the turn until credentials exist; never spawn keyless (David,
    // 2026-08-01). Model credentials arrive on a VM-sync tick, not at provision,
    // so a fresh VM has a window with none. Spawning through it hands the agent
    // no key and no gateway base URL, and the turn dies on a raw upstream `401`
    // that reads as a broken product rather than a not-ready one. A throw
    // becomes `503 runner_unavailable` at the route and the API's drain
    // redelivers the same input once credentials land — the turn is delayed,
    // not burned. A runner lives for exactly one turn, so this is the only
    // moment env has to be right; nothing needs refreshing mid-flight.
    //
    // `modelEnv` being absent ENTIRELY is a different thing — a gateway with no
    // model rail at all, as in unit tests — and stays permitted.
    const modelEnvProvider = this.options.modelEnv
    let modelEnv: Record<string, string> | undefined
    if (modelEnvProvider !== undefined) {
      const resolved = modelEnvProvider()
      if (resolved === null) throw new Error('Model credentials have not arrived yet')
      modelEnv = resolved
    }
    const startMode =
      args.envelope.launch.onboarding === true ? 'auto' : (args.envelope.launch.mode ?? 'auto')
    const now = this.options.now ?? Date.now
    const gateStartedAt = now()
    await this.options.ensureRunner?.()
    const gateWaitMs = now() - gateStartedAt
    // Re-checked after the await: a block that arrived mid-launch still stops
    // new work.
    if (this.isLaunchBlocked()) {
      throw new Error('Agent runner starts are blocked')
    }
    const runner = this.factory({
      sessionId: args.sessionId,
      cwd: spawnCwd.cwd,
      tier: args.tier,
      memoryDbPath: context.memoryDbPath,
      systemPromptFiles: context.systemPromptFiles,
      env: modelEnv,
      onOutputLimit: event =>
        this.options.log?.({
          event: 'runner_output_limit_reached',
          sessionId: args.sessionId,
          ...event,
        }),
      onProcessHandleExit: event =>
        this.options.log?.({
          event: 'runner_process_handle_exit',
          sessionId: args.sessionId,
          ...event,
        }),
    })
    this.runners.set(args.sessionId, runner)
    let relayStopped = false
    let unsubscribe: () => void = () => undefined
    let eventPipeline = Promise.resolve()
    // Snapshot order follows RPC stdout, not the upload queue. A delayed public
    // event may still be published, but must not roll recovery state backward.
    let checkpointGeneration = 0
    unsubscribe = runner.onEvent(event => {
      if (event.type === 'checkpoint') {
        if (relayStopped) return
        checkpointGeneration += 1
        void this.withSession(args.sessionId, () =>
          this.ledger.recordCheckpoint(args.sessionId, event.state),
        ).catch(error => {
          console.error(`agent checkpoint failed for ${args.sessionId}: ${String(error)}`)
        })
        return
      }
      const generation = checkpointGeneration
      eventPipeline = eventPipeline
        .then(async () => {
          if (relayStopped) return
          const parsed = AgentTurnEventSchema.safeParse(event)
          if (!parsed.success) return
          const turnEvent = parsed.data
          const eventClass = classifyAgentTurnEvent(turnEvent)

          if (eventClass === 'ephemeral') {
            buffer.push({ event: turnEvent, seq: null })
            return
          }
          if (eventClass === 'doc_patch')
            buffer.push({ event: storableEvent(turnEvent), seq: null })

          let terminalActivity = false
          let terminalType: AgentTurnEvent['type'] | undefined
          await this.withSession(args.sessionId, async () => {
            const envelope = await this.ledger.recordRunnerEvent(args.sessionId, turnEvent, {
              preserveCheckpoint: generation !== checkpointGeneration,
            })

            if (
              turnEvent.type === 'ask' ||
              turnEvent.type === 'complete' ||
              turnEvent.type === 'interrupted' ||
              turnEvent.type === 'sleep'
            ) {
              // Terminal means terminal: every terminal kills the runner,
              // including `ask`. The durable checkpoint is the only thing an
              // answer resumes from (it already had to survive gateway
              // restarts and month-long silences); a parked process was a
              // warm-start optimization that bought stale-state hazards.
              if (this.runners.get(args.sessionId) === runner) this.runners.delete(args.sessionId)
              unsubscribe()
              runner.kill()
              void this.cgroup.removeWhenDrained(args.sessionId)
              terminalType = turnEvent.type
              terminalActivity = true
            }

            if (turnEvent.type === 'sleep') {
              await this.armOrSettleWake(args.sessionId, envelope, now() - turnEvent.wakeAt)
            }
          })

          if (terminalActivity) await this.recordTerminalActivity(args.sessionId)
          await this.drainRelayOutbox(args.sessionId, buffer)
          if (terminalType !== undefined) {
            this.resolveTerminalWaiters(args.sessionId, terminalType)
          }
        })
        .catch(error => {
          if (error instanceof AgentRelayOutboxCapacityError) {
            relayStopped = true
            this.relayOverloadedSessions.add(args.sessionId)
            if (this.runners.get(args.sessionId) === runner) this.runners.delete(args.sessionId)
            unsubscribe()
            runner.kill()
            this.rejectTerminalWaiters(args.sessionId, error)
            try {
              this.options.log?.({
                event: 'runner_relay_outbox_limit_reached',
                sessionId: args.sessionId,
                action: 'runner_terminated',
                maxBytes:
                  this.options.relayOutboxLimits?.maxBytes ?? AGENT_RELAY_OUTBOX_LIMITS.maxBytes,
              })
            } catch (logError) {
              console.error(`failed to log relay outbox limit: ${String(logError)}`)
            }
            // The runner is gone, so the control plane has to be told or the
            // session reads as a live turn forever. This report is a system
            // event rather than a terminal because a terminal would fold its
            // state into the checkpoint, and the runner's real checkpoint is
            // the only thing a later answer can resume from.
            void this.reportGatewayEndedTurn(
              args.sessionId,
              buffer,
              relayBacklogEvent(),
              'relay backlog',
            )
          }
          console.error(`agent event pipeline failed for ${args.sessionId}: ${String(error)}`)
        })
    })

    const launchStartedAt = now()
    try {
      await runner.start()
      const processStartedAt = now()
      const pid = runner.getPid()
      if (pid !== null) await this.cgroup.place(pid, args.sessionId)
      const startedPromise = runner.waitForTurnStarted()
      const mcpServers = this.options.mcpServers?.(args.sessionId, args.envelope.launch) ?? null
      const hydrateStartedAt = now()
      await runner.send({
        type: 'start',
        // Start options override the checkpoint; --model is only the fallback.
        options: { model: args.envelope.launch.tier },
        ...(args.envelope.checkpoint === undefined
          ? { mode: startMode }
          : { state: args.envelope.checkpoint.state }),
        ...(mcpServers === null ? {} : { mcpServers }),
      })
      await startedPromise
      const startedAt = now()
      // Cold start latency was invisible: the ceiling was raised 30s -> 90s ->
      // 300s by inference each time, because nothing ever recorded how long a
      // start actually took. Now it does, so the bound can be set from data —
      // split by owner, because a turn's time-to-first-token is mostly spent
      // here: the install gates (this gateway), the process (the CLI's boot),
      // and hydration up to `turn_started` (the runner: checkpoint, MCP
      // connects) are three different things to fix.
      this.options.log?.({
        event: 'runner_turn_started',
        sessionId: args.sessionId,
        startedInMs: startedAt - launchStartedAt,
        gateWaitMs,
        spawnMs: processStartedAt - launchStartedAt,
        hydrateMs: startedAt - hydrateStartedAt,
      })
    } catch (error) {
      unsubscribe()
      this.discardRunner(args.sessionId, runner, error)
      throw error
    }

    // A runner that dies without ever authoring a terminal — crash, OOM kill,
    // signal, the gateway's own stdout-limit governor — leaves the session
    // reading as a live turn forever otherwise: everything else in this
    // pipeline only reacts to events the process is still alive to emit. This
    // fires on ANY death (the runner's stdout closing — see `AgentRunner.onExit`
    // for why that and not the process handle), including ones the coordinator
    // caused itself (a terminal, a relay-backlog kill, discard, interrupt
    // finding it already dead) — those all delete the runner from
    // `this.runners` before killing it, so the map identity check is the sole
    // guard needed: once any of them has run, this later fire sees a mismatch
    // and does nothing.
    //
    // The check runs only once the event pipeline has drained. Stdout closes
    // after every line has reached `onEvent`, so at exit the pipeline tail
    // holds all the runner ever said — including a terminal still queued
    // behind ledger writes, because the RPC runner exits itself the moment its
    // terminal is written. Judged before the drain, a sub-second poll turn's
    // `sleep` reads as a crash.
    runner.onExit(code => {
      void eventPipeline.then(() => {
        if (this.runners.get(args.sessionId) !== runner) return
        this.runners.delete(args.sessionId)
        unsubscribe()
        this.options.log?.({
          event: 'runner_exited',
          sessionId: args.sessionId,
          code,
          stderr: runner.getStderr(),
        })
        void this.reportGatewayEndedTurn(
          args.sessionId,
          buffer,
          runnerExitedEvent(),
          'runner-exited',
        )
      })
    })
    return runner
  }

  /**
   * Say why a turn stopped — a relay backlog or a runner that died without
   * authoring a terminal — then push whatever the journal is still holding.
   * The report queues behind whatever the outbox already has, so the session
   * only actually ends once the control plane has drained through to it.
   */
  private async reportGatewayEndedTurn(
    sessionId: string,
    buffer: SessionEventBuffer,
    event: Extract<AgentTurnEvent, { type: 'system' }>,
    failureLabel: string,
  ): Promise<void> {
    try {
      await this.withSession(sessionId, () =>
        this.ledger.recordDurableSystemEvent(sessionId, event),
      )
    } catch (error) {
      console.error(
        `agent session ${failureLabel} report failed for ${sessionId}: ${String(error)}`,
      )
    }
    await this.drainRelayOutbox(sessionId, buffer)
  }

  private async restoreWakeSchedules(): Promise<void> {
    const loaded = await this.ledger.loadAll()
    for (const quarantined of loaded.quarantined) {
      this.quarantinedSessions.add(quarantined.sessionId)
      console.error(
        `agent session ledger quarantined pre-tier record ${quarantined.path}; durable delivery must retry`,
      )
    }
    for (const corrupt of loaded.corrupt) {
      console.error(`agent session ledger ignored corrupt record ${corrupt.path}: ${corrupt.error}`)
    }
    for (const envelope of loaded.sessions) {
      if (envelope.recoveryBlocked !== undefined) continue
      void this.drainRelayOutbox(envelope.sessionId, this.bufferFor(envelope.sessionId))
      if (this.isLaunchBlocked()) continue
      try {
        if (envelope.inFlightCommands.length > 0) {
          await this.withSession(envelope.sessionId, () => this.recoverCommands(envelope))
          if (envelope.wake !== undefined) this.armWake(envelope)
          continue
        }
        const wake = envelope.wake
        if (wake === undefined) continue
        this.armWake(envelope)
      } catch (error) {
        console.error(`agent session recovery failed for ${envelope.sessionId}: ${String(error)}`)
        this.scheduleSessionRecovery(envelope.sessionId)
      }
    }
    // Observation-only repairs run serially in the background. An unavailable
    // control plane must not delay runner restoration or accepting new work.
    void (async () => {
      for (const envelope of loaded.sessions) {
        if (!isStoppedEnvelope(envelope)) continue
        try {
          await this.withSession(envelope.sessionId, () =>
            this.reconcileInterruptedProjection(envelope.sessionId),
          )
        } catch (error) {
          console.error(
            `agent session projection recovery failed for ${envelope.sessionId}: ${String(error)}`,
          )
          this.scheduleSessionRecovery(envelope.sessionId)
        }
      }
    })()
  }

  private async reconcileInterruptedProjection(sessionId: string): Promise<void> {
    if (this.options.apiUrl === undefined) return
    if (this.runners.has(sessionId) || this.launchingSessions.has(sessionId)) return
    const token = await this.options.getVmToken()
    if (token === null) throw new Error('VM is not registered')
    const url = `${this.options.apiUrl.replace(/\/+$/g, '')}/v1/vm/agent/sessions/${sessionId}/interrupted-checkpoint`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return
    if (!response.ok) throw new Error(`checkpoint target failed with HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (value === null) return
    const target = InterruptedCheckpointTargetSchema.parse(value)
    const current = await this.ledger.read(sessionId)
    if (
      current === null ||
      !isStoppedEnvelope(current) ||
      current.relayOutbox.length !== 0 ||
      this.runners.has(sessionId) ||
      this.launchingSessions.has(sessionId) ||
      current.acceptedThroughSeq !== target.acceptedThroughSeq
    )
      return
    const applied = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(10_000),
    })
    if (!applied.ok) throw new Error(`checkpoint repair failed with HTTP ${applied.status}`)
    const result: unknown = await applied.json()
    if (
      typeof result !== 'object' ||
      result === null ||
      !('repaired' in result) ||
      typeof result.repaired !== 'boolean'
    ) {
      throw new Error('checkpoint repair response missing result')
    }
    if (!result.repaired) this.scheduleSessionRecovery(sessionId)
  }

  private async recoverCommands(envelope: GatewaySessionEnvelope): Promise<void> {
    if (this.isLaunchBlocked() || envelope.recoveryBlocked !== undefined) return
    if (envelope.checkpoint === undefined) {
      throw new Error('accepted agent command has no checkpoint to hydrate')
    }
    const runner = await this.launchRunner({
      sessionId: envelope.sessionId,
      envelope,
      lastEventSeq: envelope.acceptedThroughSeq,
      cwd: envelope.launch.cwd,
      tier: envelope.launch.tier,
    })
    try {
      for (const accepted of envelope.inFlightCommands) {
        if (this.isLaunchBlocked()) return
        switch (accepted.command.type) {
          case 'prompt':
            await runner.send({
              ...accepted.command,
              requestId: accepted.requestId,
            })
            break
          case 'answer':
            await runner.send({
              ...accepted.command,
              requestId: accepted.requestId,
            })
            break
          case 'wake':
            await runner.send({ type: 'wake', requestId: accepted.requestId })
            break
        }
      }
      await this.recordAcceptedInputActivity(envelope.sessionId)
    } catch (error) {
      runner.kill()
      if (this.runners.get(envelope.sessionId) === runner) {
        this.runners.delete(envelope.sessionId)
      }
      throw error
    }
  }

  private armWake(
    envelope: Pick<GatewaySessionEnvelope, 'sessionId' | 'wake'>,
    minimumDelayMs = 0,
  ): void {
    this.cancelWakeTimer(envelope.sessionId)
    if (this.isLaunchBlocked()) return
    const wake = envelope.wake
    if (wake === undefined) return
    const remainingMs = wake.wakeAt - (this.options.now ?? Date.now)()
    const delayMs = remainingMs > 0 ? Math.min(remainingMs, MAX_TIMER_DELAY_MS) : minimumDelayMs
    const timer = this.setTimer(() => {
      const armed = this.wakeTimers.get(envelope.sessionId)
      if (armed?.generation !== wake.generation) return
      this.wakeTimers.delete(envelope.sessionId)
      void this.withSession(envelope.sessionId, () =>
        this.handleWakeTimer(envelope.sessionId, wake.generation),
      )
    }, delayMs)
    this.wakeTimers.set(envelope.sessionId, { generation: wake.generation, timer })
  }

  /**
   * A sleep whose wake time already passed when it landed asks for a relaunch
   * that would only sleep again on the same time, after zero delay, forever.
   * Waiting cannot satisfy it, so the turn ends here instead.
   */
  private async armOrSettleWake(
    sessionId: string,
    envelope: GatewaySessionState,
    staleByMs: number,
  ): Promise<void> {
    if (staleByMs <= STALE_WAKE_GRACE_MS || envelope.wake === undefined) {
      this.armWake(envelope)
      return
    }
    await this.ledger.settleWake({
      sessionId,
      generation: envelope.wake.generation,
      event: staleWakeEvent(),
    })
    this.options.log?.({ event: 'stale_wake_settled', sessionId, staleByMs })
  }

  private async handleWakeTimer(sessionId: string, generation: number): Promise<void> {
    if (this.isLaunchBlocked()) return
    const current = await this.ledger.read(sessionId)
    if (current?.wake === undefined || current.wake.generation !== generation) {
      return
    }
    if (current.wake.wakeAt > (this.options.now ?? Date.now)()) {
      this.armWake(current)
      return
    }
    await this.dispatchWake(sessionId, generation)
  }

  private cancelWakeTimer(sessionId: string): void {
    const armed = this.wakeTimers.get(sessionId)
    if (armed === undefined) return
    this.wakeTimers.delete(sessionId)
    this.clearTimer(armed.timer)
  }

  private async dispatchWake(sessionId: string, generation: number): Promise<void> {
    if (this.isLaunchBlocked()) return
    const current = await this.ledger.read(sessionId)
    if (
      current?.wake === undefined ||
      current.wake.generation !== generation ||
      current.checkpoint === undefined
    ) {
      return
    }
    const requestId = (this.options.createRequestId ?? randomUUID)()
    let launchedForWake: AgentRunner | undefined
    let wakeAccepted = false
    try {
      let acceptedLaunch = current.launch
      let runner = this.runners.get(sessionId)
      if (runner !== undefined && !runner.isAlive()) {
        this.runners.delete(sessionId)
        runner = undefined
      }
      if (runner === undefined) {
        if ((await this.options.diskGuard?.ensureWritable()) === 'full') {
          const settled = await this.ledger.settleWake({
            sessionId,
            generation,
            event: storageFullEvent(),
          })
          if (settled !== null) {
            await this.drainRelayOutbox(sessionId, this.bufferFor(sessionId))
            await this.recordTerminalActivity(sessionId)
          }
          return
        }
        let launch = current.launch
        if (this.options.refreshTurnMcp !== undefined) {
          // A wake relaunches from an envelope as old as the sleep, so both MCP
          // fields are dropped first and only what the control plane re-states
          // this turn comes back. They are re-applied one at a time and never as
          // a pair: the two sources are independent by design, and a Composio
          // outage that leaves `integrations` unanswered must not also cost the
          // session the custom servers the same response did answer.
          const { integrations: _stale, mcpServers: _staleServers, ...withoutTurnMcp } = launch
          let refreshed: GatewaySessionIntegrationsRefreshResponse | undefined
          try {
            refreshed = await this.options.refreshTurnMcp(sessionId)
          } catch (error) {
            this.options.log?.({
              operation: 'refresh_wake_turn_mcp_failed',
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          launch = {
            ...withoutTurnMcp,
            ...(refreshed?.integrations === undefined
              ? {}
              : { integrations: refreshed.integrations }),
            ...(refreshed?.mcpServers === undefined ? {} : { mcpServers: refreshed.mcpServers }),
          }
        }
        const refreshed = launch === current.launch ? current : { ...current, launch }
        acceptedLaunch = launch
        runner = await this.launchRunner({
          sessionId,
          envelope: refreshed,
          lastEventSeq: current.acceptedThroughSeq,
          cwd: launch.cwd,
          tier: launch.tier,
        })
        launchedForWake = runner
      }
      await runner.send({ type: 'wake', requestId })
      await this.ledger.acceptWake({
        sessionId,
        launch: acceptedLaunch,
        requestId,
      })
      wakeAccepted = true
      await this.recordAcceptedInputActivity(sessionId)
    } catch (error) {
      if (!wakeAccepted && launchedForWake !== undefined) {
        launchedForWake.kill()
        if (this.runners.get(sessionId) === launchedForWake) this.runners.delete(sessionId)
      }
      const retry = await this.ledger.read(sessionId)
      if (retry?.wake !== undefined) this.armWake(retry, DEFAULT_RETRY_MS)
      console.error(`agent wake dispatch failed for ${sessionId}: ${String(error)}`)
    }
  }

  private async drainRelayOutbox(sessionId: string, buffer: SessionEventBuffer): Promise<void> {
    await this.drainRelayOutboxTracked(sessionId, buffer)
  }

  private async drainRelayOutboxTracked(
    sessionId: string,
    buffer: SessionEventBuffer,
  ): Promise<void> {
    let abandonedTerminal = false
    let drainedEvents = false
    try {
      await this.ledger.drainRelayOutbox(sessionId, async item => {
        drainedEvents = true
        try {
          const result = await this.relay(
            sessionId,
            item.relayId,
            item.event,
            item.acceptedThroughSeq,
          )
          this.relayFailures.delete(sessionId)
          const seq = result?.seq ?? null
          if (classifyAgentTurnEvent(item.event) === 'canonical' && seq !== null) {
            buffer.push({ event: item.event, seq })
          }
          return { relayId: item.relayId, seq }
        } catch (error) {
          if (this.countRelayFailure(sessionId, item.relayId) < MAX_RELAY_ATTEMPTS) throw error
          // Acknowledged without a sequence rather than relayed: the record
          // leaves the journal so everything queued behind it can move. An
          // event the control plane has refused this long is one it will keep
          // refusing, and retrying it costs the whole session.
          this.relayFailures.delete(sessionId)
          abandonedTerminal ||= isTerminalEvent(item.event)
          this.options.log?.({
            event: 'agent_relay_abandoned',
            sessionId,
            relayId: item.relayId,
            eventType: item.event.type,
            attempts: MAX_RELAY_ATTEMPTS,
            error: String(error),
          })
          return { relayId: item.relayId, seq: null }
        }
      })
      const timer = this.relayRetryTimers.get(sessionId)
      if (timer !== undefined) {
        this.relayRetryTimers.delete(sessionId)
        this.clearTimer(timer)
      }
      if (this.relayOverloadedSessions.delete(sessionId)) this.scheduleSessionRecovery(sessionId)
      if (drainedEvents && this.options.apiUrl !== undefined) {
        const envelope = await this.ledger.read(sessionId)
        if (envelope !== null && isStoppedEnvelope(envelope))
          this.scheduleSessionRecovery(sessionId)
      }
    } catch (error) {
      await this.withSession(sessionId, async () => {
        if ((await this.ledger.read(sessionId)) === null) return
        console.error(`agent relay drain failed for ${sessionId}: ${String(error)}`)
        this.scheduleRelayRetry(sessionId)
      })
    }
    // The dropped terminal was the only thing that could have ended this turn,
    // so the session reads as live until something else does.
    if (abandonedTerminal) {
      await this.reportGatewayEndedTurn(
        sessionId,
        buffer,
        relayUndeliverableEvent(),
        'relay undeliverable',
      )
    }
  }

  /** Consecutive failures on the journal record the drain is stuck on. */
  private countRelayFailure(sessionId: string, relayId: string): number {
    const seen = this.relayFailures.get(sessionId)
    const attempts = seen?.relayId === relayId ? seen.attempts + 1 : 1
    this.relayFailures.set(sessionId, { relayId, attempts })
    return attempts
  }

  private scheduleRelayRetry(sessionId: string): void {
    if (this.relayRetryTimers.has(sessionId)) return
    const timer = this.setTimer(() => {
      this.relayRetryTimers.delete(sessionId)
      void this.drainRelayOutbox(sessionId, this.bufferFor(sessionId))
    }, DEFAULT_RETRY_MS)
    this.relayRetryTimers.set(sessionId, timer)
  }

  private scheduleSessionRecovery(sessionId: string): void {
    if (this.recoveryRetryTimers.has(sessionId)) return
    const attempts = this.recoveryRetryAttempts.get(sessionId) ?? 0
    this.recoveryRetryAttempts.set(sessionId, attempts + 1)
    const delayMs = Math.min(DEFAULT_RETRY_MS * 2 ** Math.min(attempts, 6), 300_000)
    const timer = this.setTimer(() => {
      this.recoveryRetryTimers.delete(sessionId)
      void this.withSession(sessionId, async () => {
        try {
          const envelope = await this.ledger.read(sessionId)
          if (envelope === null || envelope.recoveryBlocked !== undefined) return
          if (isStoppedEnvelope(envelope)) {
            await this.reconcileInterruptedProjection(sessionId)
            return
          }
          if (this.isLaunchBlocked()) return
          if (envelope.inFlightCommands.length > 0) {
            await this.recoverCommands(envelope)
            if (envelope.wake !== undefined) this.armWake(envelope)
            return
          }
          const wake = envelope.wake
          if (wake === undefined) return
          this.armWake(envelope)
        } catch (error) {
          console.error(`agent session recovery failed for ${sessionId}: ${String(error)}`)
          this.scheduleSessionRecovery(sessionId)
        } finally {
          if (!this.recoveryRetryTimers.has(sessionId)) this.recoveryRetryAttempts.delete(sessionId)
        }
      })
    }, delayMs)
    this.recoveryRetryTimers.set(sessionId, timer)
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    if (this.options.setTimer !== undefined) return this.options.setTimer(callback, delayMs)
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return timer
  }

  private clearTimer(timer: unknown): void {
    if (this.options.clearTimer !== undefined) {
      this.options.clearTimer(timer)
      return
    }
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }

  private cancelSessionTimer(timers: Map<string, unknown>, sessionId: string): void {
    const timer = timers.get(sessionId)
    if (timer === undefined) return
    timers.delete(sessionId)
    this.clearTimer(timer)
  }

  private isQuiesced(): boolean {
    return this.options.isQuiesced?.() === true
  }

  private isLaunchBlocked(): boolean {
    return this.startsBlocked || this.isQuiesced()
  }

  async discard(sessionId: string): Promise<boolean> {
    await this.ready
    return this.withSession(sessionId, async () => {
      const runner = this.runners.get(sessionId)
      const existed =
        runner !== undefined ||
        this.wakeTimers.has(sessionId) ||
        this.relayRetryTimers.has(sessionId) ||
        this.recoveryRetryTimers.has(sessionId)
      const discarded = await this.ledger.discard(sessionId)
      if (runner !== undefined) {
        runner.kill()
        this.runners.delete(sessionId)
        void this.cgroup.removeWhenDrained(sessionId)
      }
      this.rejectTerminalWaiters(sessionId, new Error('Agent session discarded'))
      this.cancelWakeTimer(sessionId)
      this.cancelSessionTimer(this.relayRetryTimers, sessionId)
      this.cancelSessionTimer(this.recoveryRetryTimers, sessionId)
      this.recoveryRetryAttempts.delete(sessionId)
      this.relayOverloadedSessions.delete(sessionId)
      this.relayFailures.delete(sessionId)
      const buffer = this.buffers.get(sessionId)
      if (buffer !== undefined) {
        buffer.dropSession()
        this.buffers.delete(sessionId)
      }
      return discarded || existed
    })
  }

  // Teardown keyed by the agent anchor bound into each envelope at spawn: deleting an
  // agent leaves the VM up, so its live runners must be stopped and tombstoned here —
  // the Convex sweep only marks the control plane. Reuses the per-session discard fence
  // rather than inventing a second teardown path.
  async discardAgent(agentAnchorId: string): Promise<string[]> {
    await this.ready
    const { sessions } = await this.ledger.loadAll()
    const targets = sessions
      .filter(session => session.agentAnchorId === agentAnchorId)
      .map(session => session.sessionId)
    const discarded: string[] = []
    for (const sessionId of targets) {
      if (await this.discard(sessionId)) discarded.push(sessionId)
    }
    return discarded
  }

  async interrupt(sessionId: string): Promise<boolean> {
    await this.ready
    const dispatched = await this.withSession(sessionId, async () => {
      const envelope = await this.ledger.read(sessionId)
      let runner = this.runners.get(sessionId)
      if (runner !== undefined && !runner.isAlive()) {
        this.runners.delete(sessionId)
        runner = undefined
      }
      if (runner === undefined) {
        if (envelope !== null && isStoppedEnvelope(envelope)) return 'settled' as const
        if (envelope?.checkpoint === undefined) {
          return null
        }
        // No process exists to interrupt. Cancel durable work without spending
        // model tokens or requiring an agent folder merely to honor a stop.
        this.cancelWakeTimer(sessionId)
        await this.ledger.settleInterrupt(sessionId)
        return 'settled' as const
      }
      const terminal = this.waitForTerminal(sessionId, 'interrupted')
      try {
        await runner.send({ type: 'interrupt' })
      } catch (error) {
        terminal.cancel()
        this.discardRunner(sessionId, runner, error)
        return null
      }
      return { runner, terminal }
    })
    if (dispatched === null) return false
    if (dispatched === 'settled') {
      await this.drainRelayOutbox(sessionId, this.bufferFor(sessionId))
      // No runner received this interrupt. The API must still settle any input
      // queued in the backend that this VM has not accepted.
      return false
    }
    try {
      await dispatched.terminal.promise
      return true
    } catch (error) {
      dispatched.terminal.cancel()
      await this.withSession(sessionId, async () => {
        this.discardRunner(sessionId, dispatched.runner, error)
      })
      return false
    }
  }

  async setCwd(sessionId: string, requestedCwd: string): Promise<GatewaySessionCwdReceipt> {
    await this.ready
    return this.withSession(sessionId, async () => {
      const envelope = await this.ledger.read(sessionId)
      if (envelope === null) throw new AgentSessionCwdError('not_found')
      const resolution = resolveSpawnCwd({
        driveDir: this.options.driveDir,
        requestedCwd,
        anchors: this.options.anchors?.() ?? [],
        agentAnchorId: envelope.agentAnchorId,
      })
      if (resolution.fallback !== undefined) {
        throw new AgentSessionCwdError('invalid_cwd', resolution.fallback.reason)
      }
      if (resolution.cwd === undefined) {
        throw new AgentSessionCwdError('invalid_cwd', 'outside_drive')
      }
      const persisted = await this.ledger.setLaunchCwd(sessionId, resolution.cwd)
      if (persisted === null) throw new AgentSessionCwdError('not_found')
      // No runner bookkeeping: terminals kill their runner, so an accepted
      // move simply lands in the envelope and the next spawn (answer, prompt,
      // or wake) hydrates under it.
      return { cwd: resolution.cwd }
    })
  }

  setQuiesced(quiesced: boolean): void {
    if (quiesced === this.projectedQuiesced) {
      if (quiesced) void this.ready.then(() => this.startQuiesceSweep())
      return
    }
    this.projectedQuiesced = quiesced
    this.quiesceGeneration += 1
    this.clearQuiesceRetry()
    if (quiesced) {
      this.cancelScheduledSessionWork()
      void this.ready.then(() => this.startQuiesceSweep())
      return
    }
    const sweep = this.quiesceSweep ?? Promise.resolve()
    void sweep
      .then(() => this.restoreWakeSchedules())
      .catch(error => {
        console.error(`agent session resume failed: ${String(error)}`)
      })
  }

  setStartsBlocked(blocked: boolean): void {
    if (blocked === this.startsBlocked) return
    this.startsBlocked = blocked
    if (blocked) {
      this.cancelScheduledSessionWork()
      return
    }
    void this.ready
      .then(() => this.restoreWakeSchedules())
      .catch(error => {
        console.error(`agent session maintenance resume failed: ${String(error)}`)
      })
  }

  private startQuiesceSweep(): void {
    if (!this.isQuiesced() || this.quiesceSweep !== null) return
    const generation = this.quiesceGeneration
    const sweep = this.runQuiesceSweep(generation).catch(error => {
      console.error(`agent session quiesce sweep failed: ${String(error)}`)
      if (this.isCurrentQuiesce(generation)) this.scheduleQuiesceRetry()
    })
    this.quiesceSweep = sweep
    void sweep.finally(() => {
      if (this.quiesceSweep !== sweep) return
      this.quiesceSweep = null
      if (this.isQuiesced() && this.quiesceGeneration !== generation) {
        this.startQuiesceSweep()
      }
    })
  }

  private async runQuiesceSweep(generation: number): Promise<void> {
    const loaded = await this.ledger.loadAll()
    for (const corrupt of loaded.corrupt) {
      console.error(`agent session ledger ignored corrupt record ${corrupt.path}: ${corrupt.error}`)
    }
    const sessionIds = new Set(this.activeSessionIds())
    for (const envelope of loaded.sessions) {
      if (isInterruptibleEnvelope(envelope)) sessionIds.add(envelope.sessionId)
    }
    const pending = [...sessionIds]
    let retryNeeded = false
    for (let offset = 0; offset < pending.length; offset += QUIESCE_COHORT_SIZE) {
      if (!this.isCurrentQuiesce(generation)) return
      const cohort = pending.slice(offset, offset + QUIESCE_COHORT_SIZE)
      const outcomes = await Promise.all(
        cohort.map(async sessionId => {
          try {
            if (await this.interrupt(sessionId)) return true
            const envelope = await this.ledger.read(sessionId)
            return envelope === null || isStoppedEnvelope(envelope)
          } catch (error) {
            console.error(`agent session interrupt failed for ${sessionId}: ${String(error)}`)
            return false
          }
        }),
      )
      if (outcomes.some(interrupted => !interrupted)) retryNeeded = true
      await Promise.resolve()
    }
    if (retryNeeded && this.isCurrentQuiesce(generation)) this.scheduleQuiesceRetry()
  }

  private isCurrentQuiesce(generation: number): boolean {
    return this.isQuiesced() && this.quiesceGeneration === generation
  }

  private scheduleQuiesceRetry(): void {
    if (this.quiesceRetryTimer !== null) return
    this.quiesceRetryTimer = this.setTimer(() => {
      this.quiesceRetryTimer = null
      this.startQuiesceSweep()
    }, DEFAULT_RETRY_MS)
  }

  private clearQuiesceRetry(): void {
    if (this.quiesceRetryTimer === null) return
    this.clearTimer(this.quiesceRetryTimer)
    this.quiesceRetryTimer = null
  }

  private cancelScheduledSessionWork(): void {
    for (const sessionId of this.wakeTimers.keys()) this.cancelWakeTimer(sessionId)
    // Recovery callbacks gate launches themselves. Keep observation retries
    // alive while paused so stale backend projections can still converge.
  }

  subscribeToEvents(sessionId: string, sinceSeq: number): SessionEventSubscription {
    return this.bufferFor(sessionId).subscribe(sinceSeq)
  }

  has(sessionId: string): boolean {
    return this.runners.has(sessionId)
  }

  activeCount(): number {
    return new Set([...this.activeSessionIds(), ...this.launchingSessions]).size
  }

  private async recordAcceptedInputActivity(sessionId: string): Promise<void> {
    try {
    } catch (error) {
      // The runner has already accepted the prompt. Reporting a delivery failure here
      // would make a retry ambiguous and could submit the same input a second time.
      console.error(`agent activity record failed for ${sessionId}: ${String(error)}`)
    }
  }

  private async recordTerminalActivity(sessionId: string): Promise<void> {
    try {
    } catch (error) {
      console.error(`agent terminal activity record failed for ${sessionId}: ${String(error)}`)
    }
  }

  private withSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.sessionTails.set(sessionId, tail)
    void tail.finally(() => {
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId)
    })
    return result
  }

  private waitForTerminal(
    sessionId: string,
    type: TerminalWaiter['type'],
    timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS,
  ): { promise: Promise<void>; cancel: () => void } {
    let waiter!: TerminalWaiter
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeTerminalWaiter(sessionId, waiter)
        reject(new Error(`Timeout waiting for agent ${type} checkpoint`))
      }, timeoutMs)
      timer.unref()
      waiter = { type, resolve, reject, timer }
      const waiters = this.terminalWaiters.get(sessionId) ?? new Set<TerminalWaiter>()
      waiters.add(waiter)
      this.terminalWaiters.set(sessionId, waiters)
    })
    return {
      promise,
      cancel: () => {
        clearTimeout(waiter.timer)
        this.removeTerminalWaiter(sessionId, waiter)
      },
    }
  }

  private resolveTerminalWaiters(sessionId: string, type: AgentTurnEvent['type']): void {
    const waiters = this.terminalWaiters.get(sessionId)
    if (waiters === undefined) return
    for (const waiter of waiters) {
      if (waiter.type !== type) continue
      clearTimeout(waiter.timer)
      this.removeTerminalWaiter(sessionId, waiter)
      waiter.resolve()
    }
  }

  private rejectTerminalWaiters(sessionId: string, error: unknown): void {
    const waiters = this.terminalWaiters.get(sessionId)
    if (waiters === undefined) return
    const reason = error instanceof Error ? error : new Error(String(error))
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      this.removeTerminalWaiter(sessionId, waiter)
      waiter.reject(reason)
    }
  }

  private removeTerminalWaiter(sessionId: string, waiter: TerminalWaiter): void {
    const waiters = this.terminalWaiters.get(sessionId)
    if (waiters === undefined) return
    waiters.delete(waiter)
    if (waiters.size === 0) this.terminalWaiters.delete(sessionId)
  }

  activeSessionIds(): string[] {
    for (const [sessionId, runner] of this.runners) {
      if (!runner.isAlive()) this.runners.delete(sessionId)
    }
    return [...this.runners.keys()]
  }

  private async relayToApi(
    sessionId: string,
    relayId: string,
    event: AgentTurnEvent,
    acceptedThroughSeq?: number,
  ): Promise<AgentRelayResult> {
    if (this.options.apiUrl === undefined)
      throw new Error('DUET_API_URL is required to relay agent events')
    const token = await this.options.getVmToken()
    if (token === null) throw new Error('VM is not registered')
    const response = await this.fetchImpl(
      `${this.options.apiUrl.replace(/\/+$/g, '')}/v1/vm/agent/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(
          AgentVmRelayEventRequestSchema.parse({
            relayId,
            event,
            ...(acceptedThroughSeq === undefined ? {} : { acceptedThroughSeq }),
          }),
        ),
      },
    )
    if (!response.ok) throw new Error(`agent event relay failed with HTTP ${response.status}`)
    const body = await readResponseJson(response)
    const seq =
      typeof body === 'object' && body !== null ? (body as { seq?: unknown }).seq : undefined
    if (typeof seq === 'number' || seq === null) return { seq }
    throw new Error('agent event relay response missing seq')
  }

  private bufferFor(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId)
    if (buffer === undefined) {
      this.evictIdleBuffers()
      buffer = new RingSessionEventBuffer({
        onSubscriberLimit: event =>
          this.options.log?.({
            event: 'session_event_subscriber_limit_reached',
            sessionId,
            ...event,
          }),
      })
      this.buffers.set(sessionId, buffer)
    }
    return buffer
  }

  // Buffers outlive their runner (so a client can reconnect across a turn's
  // terminal) but must not accumulate unbounded on a long-lived VM. Evict the
  // oldest sessions that have no active runner when we exceed the cap. We never
  // drop a buffer at the terminal event itself — dropSession() clears a
  // subscriber's queued frames, which would race the still-draining terminal
  // frame the API proxy needs to forward.
  private evictIdleBuffers(): void {
    if (this.buffers.size < MAX_SESSION_BUFFERS) return
    for (const [sessionId, buffer] of this.buffers) {
      if (this.buffers.size < MAX_SESSION_BUFFERS) break
      if (this.runners.has(sessionId)) continue
      buffer.dropSession()
      this.buffers.delete(sessionId)
    }
  }
}

function storageFullEvent(): Extract<AgentTurnEvent, { type: 'system' }> {
  return {
    type: 'system',
    level: 'error',
    message: 'Your workspace is full. Delete files to free up space, then try again.',
    metadata: { code: STORAGE_FULL_ERROR },
  }
}

function spawnCwdFallbackEvent(
  fallback: NonNullable<SpawnCwdResolution['fallback']>,
): Extract<AgentTurnEvent, { type: 'system' }> {
  return {
    type: 'system',
    level: 'warn',
    message: `The session folder "${fallback.from}" is unavailable. Continuing from "${fallback.to}".`,
    metadata: { code: SESSION_CWD_FALLBACK },
  }
}

function relayBacklogEvent(): Extract<AgentTurnEvent, { type: 'system' }> {
  return {
    type: 'system',
    level: 'error',
    message: 'This turn was stopped: its output outran what the workspace could save.',
    metadata: { code: RELAY_BACKLOG_TERMINAL },
  }
}

function relayUndeliverableEvent(): Extract<AgentTurnEvent, { type: 'system' }> {
  return {
    type: 'system',
    level: 'error',
    message: 'This turn ended: its result could not be saved.',
    metadata: { code: RELAY_UNDELIVERABLE_TERMINAL },
  }
}

// The runner-exited code already means "a turn the runner never got to
// finish"; only the copy says why.
function staleWakeEvent(): Extract<AgentTurnEvent, { type: 'system' }> {
  return runnerExitedEvent(
    'This turn stopped: the agent went back to sleep until a time that had already passed.',
  )
}

function runnerExitedEvent(
  message = 'This turn stopped: the agent exited before finishing.',
): Extract<AgentTurnEvent, { type: 'system' }> {
  return {
    type: 'system',
    level: 'error',
    message,
    metadata: { code: RUNNER_EXITED_TERMINAL },
  }
}

function boundAgentRootUnavailableEvent(): Extract<AgentTurnEvent, { type: 'system' }> {
  return {
    type: 'system',
    level: 'error',
    message: 'This session’s bound agent folder is unavailable on the new workspace VM.',
    metadata: { code: BOUND_AGENT_ROOT_UNAVAILABLE },
  }
}

function isStoppedEnvelope(envelope: GatewaySessionEnvelope): boolean {
  return (
    envelope.recoveryBlocked === undefined &&
    (envelope.stoppedThroughSeq === envelope.acceptedThroughSeq ||
      envelope.checkpoint?.terminalType === 'interrupted') &&
    envelope.inFlightCommands.length === 0 &&
    envelope.wake === undefined
  )
}

function isInterruptibleEnvelope(envelope: GatewaySessionEnvelope): boolean {
  if (isStoppedEnvelope(envelope)) return false
  if (envelope.recoveryBlocked !== undefined) return true
  const checkpoint = envelope.checkpoint
  if (checkpoint === undefined) return false
  const stateMachine = checkpoint.state.stateMachine
  if (
    stateMachine !== undefined &&
    stateMachine.terminal === undefined &&
    stateMachine.currentState !== 'interrupted'
  ) {
    return true
  }
  return (
    checkpoint.terminalType === undefined ||
    checkpoint.terminalType === 'ask' ||
    checkpoint.terminalType === 'sleep'
  )
}

function durablePromptCommand(
  args: GatewayRunnerInputRequest,
): Extract<AgentTurnCommand, { type: 'prompt' }> {
  const input = args.input
  if (input.kind === 'prompt') {
    return {
      type: 'prompt',
      message: input.message,
      behavior: input.behavior,
      ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
    }
  }
  return {
    type: 'prompt',
    message: input.answer,
    behavior: 'follow_up',
    ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
  }
}

function runnerPromptCommand(
  args: GatewayRunnerInputRequest,
  requestId: string,
): Extract<AgentTurnCommand, { type: 'prompt' }> & { requestId: string } {
  return { ...durablePromptCommand(args), requestId }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}
