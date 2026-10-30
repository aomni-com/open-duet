import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  AgentCwdSchema,
  AgentStateMachineDefinitionSchema,
  RecordedModelSelectionIdSchema,
  coerceStoredTier,
  AgentTurnCommandSchema,
  AgentTurnEventSchema,
  AgentTurnStateSchema,
  classifyAgentTurnEvent,
  isTerminalEvent,
  RELAY_BACKLOG_TERMINAL,
  INTERRUPT_UNDELIVERABLE_TERMINAL,
  type AgentTurnCommand,
  type AgentTurnEvent,
  type AgentTurnState,
  type GatewayRunnerInputRequest,
  type ModelSelectionId,
} from '@repo/contract'

import {
  defaultAtomicJsonOperations,
  writeAtomicJson,
  type AtomicJsonOperations,
} from '../atomic-json'
import { createRelayOutboxStore } from './relay-outbox'
import { storableEvent } from './storable-event'

export { AgentRelayOutboxCapacityError, AGENT_RELAY_OUTBOX_LIMITS } from './relay-outbox'

const ENVELOPE_VERSION = 1 as const
const TERMINAL_TYPES = new Set(['complete', 'ask', 'interrupted', 'sleep'])
const DISCARDED_SESSION_FILE = 'discarded.json'
const QUARANTINED_SESSION_FILE = 'session.pre-tier.json'
const RELAY_OUTBOX_FILE = 'relay-outbox.ndjson'
const RELAY_OUTBOX_RECORD_VERSION = 1 as const
export interface GatewaySessionEnvelope {
  [key: string]: unknown
  version: typeof ENVELOPE_VERSION
  sessionId: string
  agentAnchorId?: string
  launch: GatewayRunnerInputRequest['launch']
  checkpoint?: {
    state: AgentTurnState
    /** Prevents pending relay commits from replacing a newer private snapshot. */
    revision?: number
    terminalType?: 'complete' | 'ask' | 'interrupted' | 'sleep'
  }
  acceptedThroughSeq: number
  stoppedThroughSeq?: number
  /** Journal prefix already reflected in this snapshot, independent of input cursors. */
  appliedRelaySequence?: number
  recoveryBlocked?: 'ambiguous_legacy_wake'
  inFlightCommands: Array<{
    requestId: string
    throughSeq?: number
    command: AgentTurnCommand
  }>
  wake?: { wakeAt: number; generation: number }
  relayOutbox: Array<{
    relayId: string
    event: AgentTurnEvent
    acceptedThroughSeq?: number
  }>
  updatedAt: number
}

export type GatewaySessionState = Pick<
  GatewaySessionEnvelope,
  | 'version'
  | 'sessionId'
  | 'agentAnchorId'
  | 'launch'
  | 'checkpoint'
  | 'acceptedThroughSeq'
  | 'inFlightCommands'
  | 'wake'
  | 'updatedAt'
> &
  Record<string, unknown>

type RelayOutboxItem = GatewaySessionEnvelope['relayOutbox'][number]

type RelayEnvelopeCommit = {
  stoppedThroughSeq?: number
  updatedAt: number
  checkpoint?: GatewaySessionEnvelope['checkpoint']
  wake?: GatewaySessionEnvelope['wake'] | null
  inFlightCommands?: GatewaySessionEnvelope['inFlightCommands']
  acceptedThroughSeq?: number
  launch?: GatewaySessionEnvelope['launch']
}

type RelayOutboxRecord = {
  version: typeof RELAY_OUTBOX_RECORD_VERSION
  item: RelayOutboxItem
  sequence?: number
  commit: RelayEnvelopeCommit
}

interface AcceptCommandInput {
  sessionId: string
  launch: GatewaySessionEnvelope['launch']
  requestId: string
  throughSeq?: number
  command: AgentTurnCommand
}

export interface AgentSessionLedger {
  read(sessionId: string): Promise<GatewaySessionEnvelope | null>
  isDiscarded(sessionId: string): Promise<boolean>
  write(envelope: GatewaySessionEnvelope): Promise<void>
  setLaunchCwd(sessionId: string, cwd: string): Promise<GatewaySessionEnvelope | null>
  discard(sessionId: string): Promise<boolean>
  acceptCommand(input: AcceptCommandInput): Promise<GatewaySessionEnvelope>
  acceptWake(
    input: Omit<AcceptCommandInput, 'throughSeq' | 'command'>,
  ): Promise<GatewaySessionEnvelope>
  settleInput(input: {
    sessionId: string
    launch: GatewaySessionEnvelope['launch']
    throughSeq: number
    event: Extract<AgentTurnEvent, { type: 'system' }>
  }): Promise<GatewaySessionState>
  settleWake(input: {
    sessionId: string
    generation: number
    event: Extract<AgentTurnEvent, { type: 'system' }>
  }): Promise<GatewaySessionState | null>
  recordDurableSystemEvent(
    sessionId: string,
    event: Extract<AgentTurnEvent, { type: 'system' }>,
  ): Promise<GatewaySessionState>
  settleInterrupt(sessionId: string): Promise<GatewaySessionState>
  recordCheckpoint(sessionId: string, state: AgentTurnState): Promise<GatewaySessionState>
  recordRunnerEvent(
    sessionId: string,
    event: AgentTurnEvent,
    options?: { preserveCheckpoint: boolean },
  ): Promise<GatewaySessionState>
  drainRelayOutbox(
    sessionId: string,
    relay: (
      item: GatewaySessionEnvelope['relayOutbox'][number],
    ) => Promise<{ relayId: string; seq: number | null }>,
  ): Promise<Array<{ relayId: string; seq: number | null }>>
  loadAll(): Promise<{
    sessions: GatewaySessionEnvelope[]
    corrupt: Array<{ path: string; error: string }>
    quarantined: Array<{ sessionId: string; path: string }>
  }>
}

export interface AgentSessionLedgerOptions {
  stateDir: string
  now: () => number
  operations?: AtomicJsonOperations
  createRelayId?: () => string
  relayOutboxLimits?: { maxBytes: number }
  onRelayCommitFold?: () => void
  onRelayOutboxCacheEntriesChanged?: (entries: number) => void
}

export function createAgentSessionLedger(options: AgentSessionLedgerOptions): AgentSessionLedger {
  const operations = options.operations ?? defaultAtomicJsonOperations
  const createRelayId = options.createRelayId ?? randomUUID
  const tails = new Map<string, Promise<void>>()
  const relayDrains = new Map<string, Promise<Array<{ relayId: string; seq: number | null }>>>()
  const foldedStates = new Map<
    string,
    { snapshotStamp: string; outboxStamp: string; state: GatewaySessionEnvelope }
  >()
  const relayOutbox = createRelayOutboxStore({
    pathForSession: sessionId => relayOutboxPath(options.stateDir, sessionId),
    parse: parseRelayOutboxRecord,
    normalize: record => {
      const relayable = storableEvent(record.item.event)
      return relayable === record.item.event
        ? record
        : { ...record, item: { ...record.item, event: relayable } }
    },
    admitBeyondCapacity: record =>
      record.item.event.type === 'system' &&
      record.item.event.metadata?.code === RELAY_BACKLOG_TERMINAL,
    key: record => record.item.relayId,
    operations,
    limits: options.relayOutboxLimits,
    fsyncDirectory,
    onCacheEntriesChanged: options.onRelayOutboxCacheEntriesChanged,
    onUnreadableRecords: (sessionId, dropped) =>
      console.error(
        `agent session relay journal dropped ${dropped} unreadable record(s) for ${sessionId}; those events cannot be relayed`,
      ),
  })

  function serialize<T>(sessionId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(sessionId, tail)
    void tail.finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId)
    })
    return result
  }

  function foldRelayState(
    envelope: GatewaySessionEnvelope,
    records: RelayOutboxRecord[],
  ): GatewaySessionEnvelope {
    const combined: GatewaySessionEnvelope = { ...structuredClone(envelope), relayOutbox: [] }
    if (records.length > 0) combined.appliedRelaySequence ??= 0
    const legacyAppliedIndex = records.findLastIndex(
      record =>
        record.sequence === undefined &&
        ((record.item.acceptedThroughSeq !== undefined &&
          record.item.acceptedThroughSeq < envelope.acceptedThroughSeq) ||
          (record.commit.checkpoint?.revision !== undefined &&
            envelope.checkpoint?.revision !== undefined &&
            record.commit.checkpoint.revision <= envelope.checkpoint.revision)),
    )
    for (const [index, record] of records.entries()) {
      if (record.sequence === undefined) {
        // Presence at zero marks an already materialized legacy prefix. Older
        // input/revision evidence can prove the same for snapshots predating it.
        if (envelope.appliedRelaySequence !== undefined || index <= legacyAppliedIndex) continue
        const newerCheckpoint =
          record.commit.checkpoint?.revision !== undefined &&
          envelope.checkpoint?.revision !== undefined &&
          record.commit.checkpoint.revision > envelope.checkpoint.revision
        if (
          record.commit.inFlightCommands?.length === 0 &&
          !newerCheckpoint &&
          combined.inFlightCommands.some(
            item => item.command.type === 'wake' && item.throughSeq === undefined,
          )
        ) {
          // Without ordering metadata, this may be a finished wake or a later
          // accepted wake. Preserve evidence and wait for an explicit decision.
          combined.recoveryBlocked = 'ambiguous_legacy_wake'
          continue
        }
      } else if (record.sequence <= (combined.appliedRelaySequence ?? 0)) continue
      options.onRelayCommitFold?.()
      applyRelayCommit(combined, record.commit)
      combined.appliedRelaySequence = record.sequence ?? combined.appliedRelaySequence
    }
    return combined
  }

  function materializeRelayOutbox(
    state: GatewaySessionEnvelope,
    records = relayOutbox.load(state.sessionId).records,
  ): GatewaySessionEnvelope {
    return {
      ...structuredClone(state),
      relayOutbox: records.map(record => structuredClone(record.item)),
    }
  }

  function cacheFoldedState(state: GatewaySessionEnvelope): void {
    const outbox = relayOutbox.load(state.sessionId)
    if (outbox.records.length === 0) {
      foldedStates.delete(state.sessionId)
      return
    }
    foldedStates.set(state.sessionId, {
      snapshotStamp: fileStamp(sessionEnvelopePath(options.stateDir, state.sessionId)),
      outboxStamp: outbox.stamp,
      state,
    })
  }

  function appendRelayRecord(
    sessionId: string,
    state: GatewaySessionEnvelope,
    record: RelayOutboxRecord,
  ): void {
    record.sequence = (state.appliedRelaySequence ?? 0) + 1
    relayOutbox.append(sessionId, record)
    options.onRelayCommitFold?.()
    applyRelayCommit(state, record.commit)
    state.appliedRelaySequence = record.sequence
    cacheFoldedState(state)
  }

  function publicSessionState(state: GatewaySessionEnvelope): GatewaySessionState {
    const { relayOutbox: _relayOutbox, ...result } = structuredClone(state)
    return result
  }

  function acceptCommandFromDisk(
    input: AcceptCommandInput,
    consumeWake: boolean,
  ): GatewaySessionEnvelope {
    const requestId = nonEmptyString(input.requestId, 'command request id')
    const command = AgentTurnCommandSchema.parse(input.command)
    const throughSeq =
      input.throughSeq === undefined
        ? undefined
        : nonNegativeInteger(input.throughSeq, 'command cursor')
    const existing = readFromDisk(input.sessionId)
    if (
      existing?.recoveryBlocked !== undefined &&
      (throughSeq === undefined || throughSeq <= existing.acceptedThroughSeq)
    ) {
      throw new Error('ambiguous legacy wake requires newer input or stop')
    }
    if (existing !== null) {
      const prior = existing.inFlightCommands.find(item => item.requestId === requestId)
      if (prior !== undefined) {
        const same =
          prior.throughSeq === throughSeq &&
          JSON.stringify(prior.command) === JSON.stringify(command)
        if (!same) throw new Error('agent command request id was reused with different input')
        if (!consumeWake || existing.wake === undefined) return structuredClone(existing)
        delete existing.wake
        existing.updatedAt = options.now()
        return structuredClone(writeToDisk(existing))
      }
    }
    const envelope: GatewaySessionEnvelope = {
      version: ENVELOPE_VERSION,
      sessionId: input.sessionId,
      ...(existing?.agentAnchorId === undefined ? {} : { agentAnchorId: existing.agentAnchorId }),
      launch: mergeGatewaySessionLaunch(existing, input.launch),
      ...(existing?.checkpoint === undefined ? {} : { checkpoint: existing.checkpoint }),
      ...(existing?.appliedRelaySequence === undefined
        ? {}
        : { appliedRelaySequence: existing.appliedRelaySequence }),
      acceptedThroughSeq: Math.max(existing?.acceptedThroughSeq ?? 0, throughSeq ?? 0),
      inFlightCommands: [
        ...(existing?.recoveryBlocked === undefined ? (existing?.inFlightCommands ?? []) : []),
        {
          requestId,
          ...(throughSeq === undefined ? {} : { throughSeq }),
          command,
        },
      ],
      ...(consumeWake || existing?.recoveryBlocked !== undefined || existing?.wake === undefined
        ? {}
        : { wake: existing.wake }),
      relayOutbox: existing?.relayOutbox ?? [],
      updatedAt: options.now(),
    }
    return structuredClone(writeToDisk(envelope))
  }

  function readStateFromDisk(sessionId: string): GatewaySessionEnvelope | null {
    if (isDiscardedFromDisk(sessionId)) return null
    const path = sessionEnvelopePath(options.stateDir, sessionId)
    restoreRetiredSelection(path)
    if (!existsSync(path)) return null
    const snapshotStamp = fileStamp(path)
    const outbox = relayOutbox.load(sessionId)
    const cached = foldedStates.get(sessionId)
    if (cached?.snapshotStamp === snapshotStamp && cached.outboxStamp === outbox.stamp) {
      return cached.state
    }
    let envelope: GatewaySessionEnvelope
    try {
      envelope = parseGatewaySessionEnvelope(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error) {
      if (!(error instanceof InvalidSessionTierError)) throw error
      quarantineEnvelope(path)
      throw new AgentSessionEnvelopeQuarantinedError(sessionId)
    }
    if (envelope.sessionId !== sessionId) {
      throw new Error('agent session envelope id does not match its path')
    }
    const currentOutbox = relayOutbox.load(sessionId)
    const state = foldRelayState(envelope, currentOutbox.records)
    cacheFoldedState(state)
    return state
  }

  function readFromDisk(sessionId: string): GatewaySessionEnvelope | null {
    const state = readStateFromDisk(sessionId)
    return state === null ? null : materializeRelayOutbox(state)
  }

  function writeToDisk(envelopeValue: GatewaySessionEnvelope): GatewaySessionEnvelope {
    const envelope = parseGatewaySessionEnvelope(envelopeValue)
    if (isDiscardedFromDisk(envelope.sessionId)) throw new Error('agent session discarded')
    const base = { ...envelope, relayOutbox: [] }
    writeAtomicJson(
      sessionEnvelopePath(options.stateDir, envelope.sessionId),
      publicSessionState(base),
      operations,
    )
    cacheFoldedState(base)
    return materializeRelayOutbox(base)
  }

  function isDiscardedFromDisk(sessionId: string): boolean {
    return existsSync(discardedSessionPath(options.stateDir, sessionId))
  }

  function fsyncDirectory(path: string): void {
    const descriptor = operations.open(path, 'r')
    try {
      operations.fsync(descriptor)
    } finally {
      operations.close(descriptor)
    }
  }

  function commitDiscardTombstone(sessionId: string): void {
    const tombstonePath = discardedSessionPath(options.stateDir, sessionId)
    if (!existsSync(tombstonePath)) {
      try {
        writeAtomicJson(tombstonePath, { version: 1, sessionId }, operations)
        return
      } catch (error) {
        if (!existsSync(tombstonePath)) throw error
      }
    }
    // A prior atomic rename may have committed even when its directory-sync acknowledgement
    // was lost. Re-syncing converts that ambiguous result into an idempotent durable commit.
    fsyncDirectory(dirname(tombstonePath))
  }

  function cleanupDiscardedEnvelope(envelopePath: string): void {
    if (!existsSync(envelopePath)) return
    try {
      operations.remove(envelopePath)
      fsyncDirectory(dirname(envelopePath))
    } catch (error) {
      // The tombstone is already authoritative; retain and retry stale-file cleanup at boot.
      console.error(`agent session discard cleanup failed for ${envelopePath}: ${String(error)}`)
    }
  }

  function quarantineEnvelope(envelopePath: string): string {
    const quarantinePath = join(dirname(envelopePath), QUARANTINED_SESSION_FILE)
    operations.rename(envelopePath, quarantinePath)
    fsyncDirectory(dirname(envelopePath))
    return quarantinePath
  }

  function restoreRetiredSelection(envelopePath: string): void {
    if (existsSync(envelopePath)) return
    const quarantinePath = join(dirname(envelopePath), QUARANTINED_SESSION_FILE)
    if (!existsSync(quarantinePath)) return
    let envelope: GatewaySessionEnvelope
    try {
      const raw = JSON.parse(readFileSync(quarantinePath, 'utf8'))
      envelope = parseGatewaySessionEnvelope(raw)
      // `economy` was a launch selection briefly, then retired. Keep the
      // quarantined snapshot available so the current parser can coerce it to
      // the balanced default. Other quarantines remain untouched.
      if (raw.launch.tier !== 'economy') return
      if (sessionEnvelopePath(options.stateDir, envelope.sessionId) !== envelopePath) return
    } catch {
      return
    }
    operations.rename(quarantinePath, envelopePath)
    fsyncDirectory(dirname(envelopePath))
  }

  function acknowledgeRelayBatch(
    sessionId: string,
    receipts: Array<{ relayId: string; seq: number | null }>,
  ): Promise<void> {
    return serialize(sessionId, () => {
      const outbox = relayOutbox.load(sessionId)
      if (
        receipts.some((receipt, index) => outbox.records[index]?.item.relayId !== receipt.relayId)
      ) {
        throw new Error('agent relay acknowledgement is not an outbox prefix')
      }
      const envelope = readStateFromDisk(sessionId)
      if (envelope === null) throw new Error('agent session envelope not found')
      envelope.updatedAt = options.now()
      // Materialize every pending commit into the atomic session snapshot before
      // removing acknowledged journal records. A crash between these commits may
      // retry stable relay ids, but can never lose local checkpoint state.
      writeToDisk(envelope)
      relayOutbox.replace(sessionId, outbox.records.slice(receipts.length))
      cacheFoldedState(envelope)
    })
  }

  return {
    read(sessionId) {
      return serialize(sessionId, () => {
        const envelope = readFromDisk(sessionId)
        return envelope === null ? null : structuredClone(envelope)
      })
    },
    isDiscarded(sessionId) {
      return serialize(sessionId, () => isDiscardedFromDisk(sessionId))
    },
    write(envelopeValue) {
      return serialize(envelopeValue.sessionId, () => {
        const envelope = parseGatewaySessionEnvelope(envelopeValue)
        if (isDiscardedFromDisk(envelope.sessionId)) throw new Error('agent session discarded')
        writeToDisk(envelope)
      })
    },
    setLaunchCwd(sessionId, cwdValue) {
      return serialize(sessionId, () => {
        const envelope = readFromDisk(sessionId)
        if (envelope === null) return null
        const cwd = AgentCwdSchema.parse(cwdValue)
        envelope.launch = { ...envelope.launch, cwd }
        return structuredClone(writeToDisk(envelope))
      })
    },
    discard(sessionId) {
      return serialize(sessionId, () => {
        const envelopePath = sessionEnvelopePath(options.stateDir, sessionId)
        const tombstonePath = discardedSessionPath(options.stateDir, sessionId)
        const existed = existsSync(envelopePath) || existsSync(tombstonePath)
        // Session ids are never reused. Keep this durable fence permanently so a delayed
        // API dispatch cannot recreate a runner after the backend has hidden the session.
        commitDiscardTombstone(sessionId)
        cleanupDiscardedEnvelope(envelopePath)
        cleanupDiscardedEnvelope(relayOutboxPath(options.stateDir, sessionId))
        relayOutbox.forget(sessionId)
        foldedStates.delete(sessionId)
        return existed
      })
    },
    acceptCommand(input) {
      return serialize(input.sessionId, () => acceptCommandFromDisk(input, false))
    },
    acceptWake(input) {
      return serialize(input.sessionId, () =>
        acceptCommandFromDisk({ ...input, command: { type: 'wake' } }, true),
      )
    },
    settleInput(input) {
      return serialize(input.sessionId, () => {
        const throughSeq = nonNegativeInteger(input.throughSeq, 'command cursor')
        const event = AgentTurnEventSchema.parse(input.event)
        if (event.type !== 'system') throw new Error('settled input event must be a system event')
        const existing = readStateFromDisk(input.sessionId)
        if (existing !== null && throughSeq <= existing.acceptedThroughSeq) {
          return publicSessionState(existing)
        }
        const relayId = nonEmptyString(createRelayId(), 'relay id')
        const acceptedThroughSeq = Math.max(existing?.acceptedThroughSeq ?? 0, throughSeq)
        const envelope: GatewaySessionEnvelope = {
          version: ENVELOPE_VERSION,
          sessionId: input.sessionId,
          ...(existing?.agentAnchorId === undefined
            ? {}
            : { agentAnchorId: existing.agentAnchorId }),
          launch: mergeGatewaySessionLaunch(existing, input.launch),
          ...(existing?.checkpoint === undefined ? {} : { checkpoint: existing.checkpoint }),
          acceptedThroughSeq,
          ...(existing?.appliedRelaySequence === undefined
            ? {}
            : { appliedRelaySequence: existing.appliedRelaySequence }),
          inFlightCommands:
            existing?.recoveryBlocked === undefined ? (existing?.inFlightCommands ?? []) : [],
          ...(existing?.recoveryBlocked !== undefined || existing?.wake === undefined
            ? {}
            : { wake: existing.wake }),
          relayOutbox: [],
          updatedAt: options.now(),
        }
        if (existing === null) {
          writeToDisk({ ...envelope, acceptedThroughSeq: 0, relayOutbox: [] })
        }
        appendRelayRecord(input.sessionId, envelope, {
          version: RELAY_OUTBOX_RECORD_VERSION,
          item: { relayId, event, acceptedThroughSeq },
          commit: {
            acceptedThroughSeq,
            launch: envelope.launch,
            updatedAt: envelope.updatedAt,
          },
        })
        return publicSessionState(envelope)
      })
    },
    settleWake(input) {
      return serialize(input.sessionId, () => {
        const event = AgentTurnEventSchema.parse(input.event)
        if (event.type !== 'system') throw new Error('settled wake event must be a system event')
        const envelope = readStateFromDisk(input.sessionId)
        if (envelope?.wake === undefined || envelope.wake.generation !== input.generation) {
          return null
        }
        const relayId = nonEmptyString(createRelayId(), 'relay id')
        const updatedAt = options.now()
        appendRelayRecord(input.sessionId, envelope, {
          version: RELAY_OUTBOX_RECORD_VERSION,
          item: { relayId, event, acceptedThroughSeq: envelope.acceptedThroughSeq },
          commit: { wake: null, updatedAt },
        })
        return publicSessionState(envelope)
      })
    },
    recordDurableSystemEvent(sessionId, eventValue) {
      return serialize(sessionId, () => {
        const envelope = readStateFromDisk(sessionId)
        if (envelope === null) throw new Error('agent session envelope not found')
        const event = AgentTurnEventSchema.parse(eventValue)
        if (event.type !== 'system') throw new Error('durable system event must be a system event')
        const relayId = nonEmptyString(createRelayId(), 'relay id')
        appendRelayRecord(sessionId, envelope, {
          version: RELAY_OUTBOX_RECORD_VERSION,
          item: { relayId, event, acceptedThroughSeq: envelope.acceptedThroughSeq },
          commit: { updatedAt: options.now() },
        })
        return publicSessionState(envelope)
      })
    },
    settleInterrupt(sessionId) {
      return serialize(sessionId, () => {
        const envelope = readStateFromDisk(sessionId)
        if (envelope === null) throw new Error('agent session envelope not found')
        if (envelope.stoppedThroughSeq === envelope.acceptedThroughSeq)
          return publicSessionState(envelope)
        const event: Extract<AgentTurnEvent, { type: 'system' }> = {
          type: 'system',
          level: 'info',
          message: 'The session was stopped without restarting its absent runner.',
          metadata: { code: INTERRUPT_UNDELIVERABLE_TERMINAL },
        }
        appendRelayRecord(sessionId, envelope, {
          version: RELAY_OUTBOX_RECORD_VERSION,
          item: {
            relayId: nonEmptyString(createRelayId(), 'relay id'),
            event,
            acceptedThroughSeq: envelope.acceptedThroughSeq,
          },
          commit: { stoppedThroughSeq: envelope.acceptedThroughSeq, updatedAt: options.now() },
        })
        return publicSessionState(envelope)
      })
    },
    recordCheckpoint(sessionId, stateValue) {
      return serialize(sessionId, () => {
        const existing = readStateFromDisk(sessionId)
        if (existing === null) throw new Error('agent session envelope not found')
        const state = { ...stateValue, ...AgentTurnStateSchema.parse(stateValue) }
        existing.checkpoint = { state, revision: (existing.checkpoint?.revision ?? 0) + 1 }
        existing.updatedAt = options.now()
        writeToDisk(existing)
        cacheFoldedState(existing)
        return publicSessionState(existing)
      })
    },
    recordRunnerEvent(sessionId, eventValue, recordOptions) {
      return serialize(sessionId, () => {
        const existing = readStateFromDisk(sessionId)
        if (existing === null) throw new Error('agent session envelope not found')
        const event = AgentTurnEventSchema.parse(eventValue)
        const nextCheckpoint = recordOptions?.preserveCheckpoint
          ? existing.checkpoint
          : checkpointAfterEvent(existing.checkpoint, event)
        const checkpoint =
          nextCheckpoint !== existing.checkpoint &&
          nextCheckpoint !== undefined &&
          existing.checkpoint?.revision !== undefined
            ? { ...nextCheckpoint, revision: existing.checkpoint.revision + 1 }
            : nextCheckpoint
        const wake = wakeAfterEvent(existing.wake, event)
        const eventClass = classifyAgentTurnEvent(event)
        if (eventClass === 'ephemeral') return publicSessionState(existing)
        const relayId = nonEmptyString(createRelayId(), 'relay id')
        const updatedAt = options.now()
        appendRelayRecord(sessionId, existing, {
          version: RELAY_OUTBOX_RECORD_VERSION,
          item: { relayId, event, acceptedThroughSeq: existing.acceptedThroughSeq },
          commit: {
            ...(checkpoint === existing.checkpoint ? {} : { checkpoint }),
            ...(wake === existing.wake ? {} : { wake: wake ?? null }),
            ...(isTerminalEvent(event) ? { inFlightCommands: [] } : {}),
            updatedAt,
          },
        })
        return publicSessionState(existing)
      })
    },
    drainRelayOutbox(sessionId, relay) {
      const active = relayDrains.get(sessionId)
      if (active !== undefined) return active
      const drain = (async () => {
        const allReceipts: Array<{ relayId: string; seq: number | null }> = []
        while (true) {
          const items = await serialize(sessionId, () => {
            const envelope = readFromDisk(sessionId)
            if (envelope === null) throw new Error('agent session envelope not found')
            return structuredClone(envelope.relayOutbox)
          })
          if (items.length === 0) return allReceipts
          const batchReceipts: Array<{ relayId: string; seq: number | null }> = []
          try {
            for (const item of items) {
              const receipt = await relay(item)
              if (receipt.relayId !== item.relayId) {
                throw new Error('agent relay receipt id mismatch')
              }
              if (receipt.seq !== null && (!Number.isSafeInteger(receipt.seq) || receipt.seq < 0)) {
                throw new Error('invalid agent relay receipt sequence')
              }
              batchReceipts.push(receipt)
            }
          } catch (error) {
            if (batchReceipts.length > 0) {
              await acknowledgeRelayBatch(sessionId, batchReceipts)
              allReceipts.push(...batchReceipts)
            }
            throw error
          }
          await acknowledgeRelayBatch(sessionId, batchReceipts)
          allReceipts.push(...batchReceipts)
        }
      })().finally(() => relayDrains.delete(sessionId))
      relayDrains.set(sessionId, drain)
      return drain
    },
    async loadAll() {
      const root = resolve(options.stateDir, 'agent-sessions')
      if (!existsSync(root)) return { sessions: [], corrupt: [], quarantined: [] }
      const sessions: GatewaySessionEnvelope[] = []
      const corrupt: Array<{ path: string; error: string }> = []
      const quarantined: Array<{ sessionId: string; path: string }> = []
      for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const path = join(root, entry.name, 'session.json')
        if (existsSync(join(root, entry.name, DISCARDED_SESSION_FILE))) {
          cleanupDiscardedEnvelope(path)
          continue
        }
        try {
          restoreRetiredSelection(path)
          if (!existsSync(path)) continue
          const envelope = parseGatewaySessionEnvelope(JSON.parse(readFileSync(path, 'utf8')))
          const expected = sessionEnvelopePath(options.stateDir, envelope.sessionId)
          if (expected !== path)
            throw new Error('agent session envelope id does not match its path')
          sessions.push(readFromDisk(envelope.sessionId)!)
        } catch (error) {
          if (error instanceof InvalidSessionTierError) {
            const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: unknown }
            const sessionId = nonEmptyString(raw.sessionId, 'agent session id')
            quarantined.push({ sessionId, path: quarantineEnvelope(path) })
            continue
          }
          corrupt.push({
            path,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      return {
        sessions: structuredClone(sessions),
        corrupt,
        quarantined: structuredClone(quarantined),
      }
    },
  }
}

function checkpointAfterEvent(
  current: GatewaySessionEnvelope['checkpoint'],
  event: AgentTurnEvent,
): GatewaySessionEnvelope['checkpoint'] {
  switch (event.type) {
    case 'turn_started':
      return { state: event.state }
    case 'todos':
      return patchCheckpoint(current, { todos: event.todos })
    case 'follow_up_queue':
      return patchCheckpoint(current, { followUpQueue: event.followUpQueue })
    case 'state_machine':
      // A display projection cannot advance recovery ahead of its worker and transcript.
      return current
    case 'complete':
    case 'ask':
    case 'interrupted':
    case 'sleep':
      return { state: event.state, terminalType: event.type }
    default:
      return current
  }
}

function patchCheckpoint(
  current: GatewaySessionEnvelope['checkpoint'],
  patch: Partial<AgentTurnState>,
): GatewaySessionEnvelope['checkpoint'] {
  if (current === undefined) throw new Error('agent document patch arrived before a checkpoint')
  return { ...current, state: { ...current.state, ...patch } }
}

function wakeAfterEvent(
  current: GatewaySessionEnvelope['wake'],
  event: AgentTurnEvent,
): GatewaySessionEnvelope['wake'] {
  if (event.type === 'sleep') {
    return { wakeAt: event.wakeAt, generation: (current?.generation ?? 0) + 1 }
  }
  if (event.type === 'interrupted') return undefined
  return current
}

export function sessionEnvelopePath(stateDir: string, sessionId: string): string {
  if (sessionId.length === 0) throw new Error('agent session id must not be empty')
  const safeSessionId = createHash('sha256').update(sessionId).digest('hex')
  return resolve(stateDir, 'agent-sessions', safeSessionId, 'session.json')
}

function discardedSessionPath(stateDir: string, sessionId: string): string {
  return join(dirname(sessionEnvelopePath(stateDir, sessionId)), DISCARDED_SESSION_FILE)
}

function relayOutboxPath(stateDir: string, sessionId: string): string {
  return join(dirname(sessionEnvelopePath(stateDir, sessionId)), RELAY_OUTBOX_FILE)
}

function fileStamp(path: string): string {
  const stat = statSync(path)
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

function applyRelayCommit(envelope: GatewaySessionEnvelope, commit: RelayEnvelopeCommit): void {
  if (
    commit.stoppedThroughSeq !== undefined &&
    commit.stoppedThroughSeq === envelope.acceptedThroughSeq
  ) {
    delete envelope.recoveryBlocked
    envelope.stoppedThroughSeq = commit.stoppedThroughSeq
    envelope.inFlightCommands = []
    delete envelope.wake
  }

  if (
    commit.checkpoint !== undefined &&
    (commit.checkpoint.revision ?? 0) >= (envelope.checkpoint?.revision ?? 0)
  ) {
    envelope.checkpoint = structuredClone(commit.checkpoint)
  }
  if (commit.wake === null) delete envelope.wake
  else if (commit.wake !== undefined) envelope.wake = structuredClone(commit.wake)
  if (commit.inFlightCommands !== undefined) {
    envelope.inFlightCommands = structuredClone(commit.inFlightCommands)
  }
  if (commit.acceptedThroughSeq !== undefined) {
    if (
      envelope.recoveryBlocked !== undefined &&
      commit.acceptedThroughSeq > envelope.acceptedThroughSeq
    ) {
      delete envelope.recoveryBlocked
      envelope.inFlightCommands = []
      delete envelope.wake
    }
    envelope.acceptedThroughSeq = Math.max(envelope.acceptedThroughSeq, commit.acceptedThroughSeq)
  }
  if (commit.launch !== undefined) envelope.launch = structuredClone(commit.launch)
  envelope.updatedAt = Math.max(envelope.updatedAt, commit.updatedAt)
}

function parseRelayOutboxRecord(value: unknown): RelayOutboxRecord {
  const record = recordValue(value)
  if (record.version !== RELAY_OUTBOX_RECORD_VERSION) {
    throw new Error('unsupported agent relay outbox version')
  }
  const relay = recordValue(record.item)
  const parsedEvent = AgentTurnEventSchema.parse(relay.event)
  const item: RelayOutboxItem = {
    ...relay,
    relayId: nonEmptyString(relay.relayId, 'relay id'),
    event: { ...recordValue(relay.event), ...parsedEvent },
    ...(relay.acceptedThroughSeq === undefined
      ? {}
      : {
          acceptedThroughSeq: nonNegativeInteger(relay.acceptedThroughSeq, 'relay accepted cursor'),
        }),
  }
  const rawCommit = recordValue(record.commit)
  const commit: RelayEnvelopeCommit = {
    updatedAt: finiteNumber(rawCommit.updatedAt, 'agent session updated time'),
    ...(rawCommit.stoppedThroughSeq === undefined
      ? {}
      : { stoppedThroughSeq: nonNegativeInteger(rawCommit.stoppedThroughSeq, 'stopped cursor') }),
    ...(rawCommit.checkpoint === undefined
      ? {}
      : { checkpoint: parseCheckpoint(rawCommit.checkpoint) }),
    ...(rawCommit.wake === undefined
      ? {}
      : { wake: rawCommit.wake === null ? null : parseWake(rawCommit.wake) }),
    ...(rawCommit.inFlightCommands === undefined
      ? {}
      : {
          inFlightCommands: parseGatewaySessionEnvelope({
            version: ENVELOPE_VERSION,
            sessionId: 'relay-commit-validation',
            launch: { tier: 'balanced' },
            acceptedThroughSeq: Number.MAX_SAFE_INTEGER,
            inFlightCommands: rawCommit.inFlightCommands,
            relayOutbox: [],
            updatedAt: 0,
          }).inFlightCommands,
        }),
    ...(rawCommit.acceptedThroughSeq === undefined
      ? {}
      : {
          acceptedThroughSeq: nonNegativeInteger(rawCommit.acceptedThroughSeq, 'accepted cursor'),
        }),
    ...(rawCommit.launch === undefined
      ? {}
      : {
          launch: parseGatewaySessionEnvelope({
            version: ENVELOPE_VERSION,
            sessionId: 'relay-commit-validation',
            launch: rawCommit.launch,
            acceptedThroughSeq: 0,
            inFlightCommands: [],
            relayOutbox: [],
            updatedAt: 0,
          }).launch,
        }),
  }
  return {
    version: RELAY_OUTBOX_RECORD_VERSION,
    item,
    commit,
    ...(record.sequence === undefined
      ? {}
      : { sequence: nonNegativeInteger(record.sequence, 'relay sequence') }),
  }
}

export function parseGatewaySessionEnvelope(value: unknown): GatewaySessionEnvelope {
  const record = recordValue(value)
  if (record.version !== ENVELOPE_VERSION) {
    throw new Error('unsupported agent session envelope version')
  }
  const sessionId = nonEmptyString(record.sessionId, 'agent session id')
  const agentAnchorId =
    record.agentAnchorId === undefined
      ? undefined
      : nonEmptyString(record.agentAnchorId, 'agent anchor id')
  const launchRecord = recordValue(record.launch)
  const launch = {
    ...launchRecord,
    ...(launchRecord.cwd === undefined ? {} : { cwd: AgentCwdSchema.parse(launchRecord.cwd) }),
    tier: parseSessionTier(launchRecord.tier),
    ...(launchRecord.onboarding === undefined
      ? {}
      : { onboarding: booleanValue(launchRecord.onboarding, 'agent onboarding launch') }),
    ...(launchRecord.mode === undefined
      ? {}
      : { mode: AgentStateMachineDefinitionSchema.parse(launchRecord.mode) }),
  }
  const checkpoint = parseCheckpoint(record.checkpoint)
  const acceptedThroughSeq = nonNegativeInteger(record.acceptedThroughSeq, 'accepted cursor')
  const stoppedThroughSeq =
    record.stoppedThroughSeq === undefined
      ? undefined
      : nonNegativeInteger(record.stoppedThroughSeq, 'stopped cursor')
  const inFlightCommands = arrayValue(record.inFlightCommands, 'in-flight commands').map(value => {
    const command = recordValue(value)
    const parsedCommand = AgentTurnCommandSchema.parse(command.command)
    return {
      ...command,
      requestId: nonEmptyString(command.requestId, 'command request id'),
      ...(command.throughSeq === undefined
        ? {}
        : { throughSeq: nonNegativeInteger(command.throughSeq, 'command cursor') }),
      command: { ...recordValue(command.command), ...parsedCommand },
    }
  })
  assertUnique(
    inFlightCommands.map(command => command.requestId),
    'duplicate agent command request id',
  )
  if (
    inFlightCommands.some(
      command => command.throughSeq !== undefined && command.throughSeq > acceptedThroughSeq,
    )
  ) {
    throw new Error('agent command cursor exceeds accepted cursor')
  }
  const wake = parseWake(record.wake)
  const updatedAt = finiteNumber(record.updatedAt, 'agent session updated time')
  return {
    version: ENVELOPE_VERSION,
    sessionId,
    ...(agentAnchorId === undefined ? {} : { agentAnchorId }),
    launch,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    acceptedThroughSeq,
    ...(stoppedThroughSeq === undefined ? {} : { stoppedThroughSeq }),
    ...(record.appliedRelaySequence === undefined
      ? {}
      : {
          appliedRelaySequence: nonNegativeInteger(
            record.appliedRelaySequence,
            'applied relay sequence',
          ),
        }),
    ...(record.recoveryBlocked === 'ambiguous_legacy_wake'
      ? { recoveryBlocked: record.recoveryBlocked }
      : {}),
    inFlightCommands,
    ...(wake === undefined ? {} : { wake }),
    relayOutbox: [],
    updatedAt,
  }
}

export class AgentSessionEnvelopeQuarantinedError extends Error {
  constructor(sessionId: string) {
    super(`Agent session envelope quarantined; retry delivery for ${sessionId}`)
    this.name = 'AgentSessionEnvelopeQuarantinedError'
  }
}

class InvalidSessionTierError extends Error {}

function parseSessionTier(value: unknown): ModelSelectionId {
  const parsed = RecordedModelSelectionIdSchema.safeParse(value)
  if (!parsed.success) throw new InvalidSessionTierError('invalid agent session tier')
  return parsed.data === 'economy' ? 'balanced' : coerceStoredTier(parsed.data, { subscriber: false })
}

function parseCheckpoint(value: unknown): GatewaySessionEnvelope['checkpoint'] {
  if (value === undefined) return undefined
  const checkpoint = recordValue(value)
  const terminalType = checkpoint.terminalType
  if (terminalType !== undefined && !TERMINAL_TYPES.has(terminalType as string)) {
    throw new Error('invalid agent session terminal type')
  }
  return {
    ...checkpoint,
    state: { ...recordValue(checkpoint.state), ...AgentTurnStateSchema.parse(checkpoint.state) },
    ...(terminalType === undefined
      ? {}
      : {
          terminalType: terminalType as NonNullable<
            GatewaySessionEnvelope['checkpoint']
          >['terminalType'],
        }),
  }
}

function parseWake(value: unknown): GatewaySessionEnvelope['wake'] {
  if (value === undefined) return undefined
  const wake = recordValue(value)
  const wakeWithoutClaim = { ...wake }
  delete wakeWithoutClaim.claim
  return {
    ...wakeWithoutClaim,
    wakeAt: finiteNumber(wake.wakeAt, 'wake time'),
    generation: positiveInteger(wake.generation, 'wake generation'),
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid agent session envelope')
  }
  return value as Record<string, unknown>
}

// Launch has two kinds of field and they persist differently.
//
// `onboarding` and `mode` are session *identity*: they decide which system
// prompt and state machine every relaunch of this session runs under, so
// creation settles them and no later request may flip or drop them — otherwise
// turn two, or a request from a writer that predates either field, would quietly
// run a different session.
//
// `cwd`, `tier`, `integrations`, and `mcpServers` are session *parameters* that can change
// between turns. They must keep tracking the latest accepted input, because
// wake and crash recovery relaunch from the persisted envelope — freezing them
// would resurrect the model or tool permissions the user already moved off.
//
// Unknown keys ride along from whichever side has them, newest wins, so a field
// written by a newer gateway survives a rewrite by an older one.
export function mergeGatewaySessionLaunch(
  existing: GatewaySessionEnvelope | null,
  input: GatewaySessionEnvelope['launch'],
): GatewaySessionEnvelope['launch'] {
  if (existing === null) return input
  const onboarding = existing.launch.onboarding ?? input.onboarding
  const mode = existing.launch.mode ?? input.mode
  const merged = {
    ...existing.launch,
    ...input,
    ...(onboarding === undefined ? {} : { onboarding }),
    ...(mode === undefined ? {} : { mode }),
  }
  // Unlike unknown version-skewed fields, these known permission boundaries are
  // fail-closed: an omitted field means this launch has no MCP servers of that
  // kind, never that it should inherit a previous turn's access. Both kinds need
  // their own line — a server the user removed would otherwise resurrect from
  // this envelope and stay forever, because every later turn re-merges it.
  if (input.integrations === undefined) delete merged.integrations
  if (input.mcpServers === undefined) delete merged.mcpServers
  return merged
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`)
  return value
}

function assertUnique(values: string[], error: string): void {
  if (new Set(values).size !== values.length) throw new Error(error)
}

function nonEmptyString(value: unknown, label: string): string {
  const parsed = stringValue(value, label)
  if (parsed.length === 0) throw new Error(`${label} must not be empty`)
  return parsed
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`invalid ${label}`)
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid ${label}`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${label}`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${label}`)
  return parsed
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label)
  if (parsed === 0) throw new Error(`invalid ${label}`)
  return parsed
}
