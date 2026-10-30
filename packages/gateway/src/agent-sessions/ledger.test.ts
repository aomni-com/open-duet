import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  AgentTurnEventSchema,
  type AgentTurnState,
  CONVEX_EVENT_BUDGET_BYTES,
} from '@repo/contract'

import { defaultAtomicJsonOperations } from '../atomic-json'
import {
  AgentRelayOutboxCapacityError,
  createAgentSessionLedger,
  sessionEnvelopePath,
  type GatewaySessionEnvelope,
} from './ledger'
import { createRelayOutboxStore } from './relay-outbox'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'duet-agent-session-ledger-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('agent session ledger', () => {
  test('one failed retired snapshot restoration does not block other sessions', async () => {
    const sessionId = 'restore-fails'
    const path = sessionEnvelopePath(stateDir, sessionId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      join(dirname(path), 'session.pre-tier.json'),
      JSON.stringify({
        ...emptyEnvelope(sessionId, 10),
        launch: { tier: 'economy' },
      }),
    )
    await createAgentSessionLedger({ stateDir, now: () => 20 }).write(emptyEnvelope('healthy', 10))
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 20,
      operations: {
        ...defaultAtomicJsonOperations,
        rename: () => {
          throw new Error('restore rename failed')
        },
      },
    })
    const result = await ledger.loadAll()
    expect(result.sessions).toEqual([emptyEnvelope('healthy', 10)])
    expect(result.corrupt).toEqual([{ path, error: 'restore rename failed' }])
  })

  test('recovers a retired selection already quarantined by an earlier gateway', async () => {
    const sessionId = 'quarantined-retired-selection'
    const path = sessionEnvelopePath(stateDir, sessionId)
    const saved = {
      ...emptyEnvelope(sessionId, 10),
      launch: { tier: 'economy' },
      acceptedThroughSeq: 3,
      wake: { wakeAt: 100, generation: 2 },
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(join(dirname(path), 'session.pre-tier.json'), JSON.stringify(saved))
    const ledger = createAgentSessionLedger({ stateDir, now: () => 20 })
    expect((await ledger.loadAll()).sessions).toEqual([{ ...saved, launch: { tier: 'balanced' } }])
    expect(await ledger.read(sessionId)).toEqual({ ...saved, launch: { tier: 'balanced' } })
    expect(await readdir(dirname(path))).toContain('session.json')
  })

  test('a retired selection preserves continuation state through recovery and new input', async () => {
    const sessionId = 'retired-selection'
    const saved = {
      ...emptyEnvelope(sessionId, 10),
      launch: { tier: 'economy' },
      acceptedThroughSeq: 3,
      checkpoint: {
        state: {
          status: 'sleeping',
          mode: 'agent',
          agent: {
            status: 'completed',
            messages: [{ role: 'user', content: 'Keep this context', timestamp: 10 }],
          },
        },
      } satisfies GatewaySessionEnvelope['checkpoint'],
      wake: { wakeAt: 100, generation: 2 },
    }
    const path = sessionEnvelopePath(stateDir, sessionId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(saved))
    const ledger = createAgentSessionLedger({ stateDir, now: () => 20 })
    const recovered = await ledger.loadAll()
    expect(recovered.quarantined).toEqual([])
    expect(recovered.corrupt).toEqual([])
    expect(recovered.sessions).toEqual([{ ...saved, launch: { tier: 'balanced' } }])
    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'frontier' },
      requestId: 'continue',
      throughSeq: 4,
      command: { type: 'prompt', message: 'Continue from that context', behavior: 'steer' },
    })
    const resumed = await createAgentSessionLedger({ stateDir, now: () => 30 }).read(sessionId)
    expect(resumed?.checkpoint).toEqual(saved.checkpoint)
    expect(resumed?.launch.tier).toBe('frontier')
    expect(resumed?.acceptedThroughSeq).toBe(4)
    expect(resumed?.inFlightCommands[0]?.command).toEqual({
      type: 'prompt',
      message: 'Continue from that context',
      behavior: 'steer',
    })
  })

  test('execution receipts survive wire parsing, checkpoint restart, and relay replay', async () => {
    const execution = {
      id: 'execution-2',
      state: 'repair',
      kind: 'agent' as const,
      fingerprint: 'a'.repeat(64),
      cwd: '/workspace/site',
      forkContext: true,
      suppliedInputKeys: ['correction', 'unreferenced'],
      renderedInputKeys: ['correction'],
      persistOverride: false,
      preview: 'Use populated people records.',
      previewTruncated: true,
      inheritedContextHash: 'b'.repeat(64),
      unchangedFrom: { id: 'execution-1', outcome: 'failed' as const },
    }
    const stateMachine = {
      definition: {
        name: 'repair search',
        prompt: 'Finish the requested search change.',
        states: [{ name: 'repair', kind: 'agent', prompt: 'Use populated people records.' }],
      },
      prompt: 'Repair search',
      currentState: 'repair',
      history: [{ type: 'state_started', timestamp: 20, state: 'repair', execution }],
      createdAt: 10,
      updatedAt: 20,
    } satisfies NonNullable<AgentTurnState['stateMachine']>
    const parsed = AgentTurnEventSchema.parse({ type: 'state_machine', stateMachine })
    if (parsed.type !== 'state_machine') throw new Error('Expected a state-machine event')
    const state: AgentTurnState = {
      mode: 'auto',
      status: 'running',
      agent: { status: 'running', messages: [] },
      stateMachine: parsed.stateMachine,
    }
    const ledger = createAgentSessionLedger({ stateDir, now: () => 30 })
    await ledger.write(emptyEnvelope('execution-receipts', 10))
    await ledger.recordRunnerEvent('execution-receipts', parsed)
    await ledger.recordCheckpoint('execution-receipts', state)
    const restored = await createAgentSessionLedger({ stateDir, now: () => 40 }).read(
      'execution-receipts',
    )
    expect(restored?.checkpoint?.state.stateMachine).toEqual(stateMachine)
    expect(restored?.relayOutbox.map(item => item.event)).toEqual([
      { type: 'state_machine', stateMachine },
    ])
  })

  test('an old native terminal cannot erase a newer accepted prompt on restart', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    const sessionId = 'terminal-before-new-input'
    await ledger.write({ ...emptyEnvelope(sessionId, 10), acceptedThroughSeq: 2 })
    await ledger.recordRunnerEvent(sessionId, {
      type: 'interrupted',
      state: { status: 'interrupted', mode: 'agent', agent: { status: 'cancelled', messages: [] } },
    })
    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'new-input',
      throughSeq: 5,
      command: { type: 'prompt', message: 'continue', behavior: 'steer' },
    })
    const restored = await createAgentSessionLedger({ stateDir, now: () => 20 }).read(sessionId)
    expect(restored?.inFlightCommands).toEqual([
      {
        requestId: 'new-input',
        throughSeq: 5,
        command: { type: 'prompt', message: 'continue', behavior: 'steer' },
      },
    ])
    expect(restored?.relayOutbox.map(item => item.event.type)).toEqual(['interrupted'])
    expect(restored?.acceptedThroughSeq).toBe(5)
  })

  test('a materialized sleep cannot consume its later wake at the same input cursor', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    const sessionId = 'sleep-before-autonomous-wake'
    await ledger.write({ ...emptyEnvelope(sessionId, 10), acceptedThroughSeq: 2 })
    await ledger.recordRunnerEvent(sessionId, {
      type: 'sleep',
      wakeAt: 100,
      state: { status: 'sleeping', mode: 'agent', agent: { status: 'waiting', messages: [] } },
    })
    await ledger.acceptWake({ sessionId, launch: { tier: 'balanced' }, requestId: 'new-wake' })
    const restored = await createAgentSessionLedger({ stateDir, now: () => 20 }).read(sessionId)
    expect(restored?.acceptedThroughSeq).toBe(2)
    expect(restored?.inFlightCommands).toEqual([
      { requestId: 'new-wake', command: { type: 'wake' } },
    ])
    expect(restored?.wake).toBeUndefined()
    expect(restored?.relayOutbox.map(item => item.event.type)).toEqual(['sleep'])
  })

  test('snapshot-before-ack recovery preserves newer work and applies records after a pruned frontier', async () => {
    let failPrune = false
    const sessionId = 'snapshot-before-journal-prune'
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 10,
      createRelayId: () => 'old-terminal',
      operations: {
        ...defaultAtomicJsonOperations,
        rename(from, to) {
          if (failPrune && to.endsWith('relay-outbox.ndjson'))
            throw new Error('crash before journal prune')
          defaultAtomicJsonOperations.rename(from, to)
        },
        remove(path) {
          if (failPrune && path.endsWith('relay-outbox.ndjson'))
            throw new Error('crash before journal prune')
          defaultAtomicJsonOperations.remove(path)
        },
      },
    })
    await ledger.write(emptyEnvelope(sessionId, 10))
    await ledger.recordRunnerEvent(sessionId, {
      type: 'interrupted',
      state: { status: 'interrupted', mode: 'agent', agent: { status: 'cancelled', messages: [] } },
    })
    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'resume',
      throughSeq: 5,
      command: { type: 'prompt', message: 'continue', behavior: 'steer' },
    })
    failPrune = true
    await expect(
      ledger.drainRelayOutbox(sessionId, async item => ({ relayId: item.relayId, seq: 9 })),
    ).rejects.toThrow('crash before journal prune')
    const restarted = createAgentSessionLedger({
      stateDir,
      now: () => 20,
      createRelayId: () => 'new-turn',
    })
    expect((await restarted.read(sessionId))?.inFlightCommands.map(item => item.requestId)).toEqual(
      ['resume'],
    )
    const relayed: string[] = []
    await restarted.drainRelayOutbox(sessionId, async item => {
      relayed.push(item.relayId)
      return { relayId: item.relayId, seq: 9 }
    })
    expect(relayed).toEqual(['old-terminal'])
    const next = {
      status: 'running' as const,
      mode: 'agent' as const,
      agent: { status: 'running' as const, messages: [] },
    }
    await restarted.recordRunnerEvent(sessionId, { type: 'turn_started', state: next })
    const restored = await createAgentSessionLedger({ stateDir, now: () => 30 }).read(sessionId)
    expect(restored?.checkpoint?.state).toEqual(next)
    expect(restored?.inFlightCommands.map(item => item.requestId)).toEqual(['resume'])
    expect(restored?.relayOutbox.map(item => item.relayId)).toEqual(['new-turn'])
  })

  test('legacy materialized terminals preserve a newer input without a journal frontier', async () => {
    const sessionId = 'legacy-terminal-before-prompt'
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write({ ...emptyEnvelope(sessionId, 10), acceptedThroughSeq: 2 })
    await ledger.recordRunnerEvent(sessionId, {
      type: 'interrupted',
      state: {
        status: 'interrupted',
        mode: 'agent',
        agent: { status: 'cancelled', messages: [] },
      },
    })
    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'legacy-resume',
      throughSeq: 5,
      command: { type: 'prompt', message: 'continue', behavior: 'steer' },
    })
    await removeJournalOrderingMetadata(sessionId)
    const restored = await createAgentSessionLedger({ stateDir, now: () => 20 }).read(sessionId)
    expect(restored?.inFlightCommands.map(item => item.requestId)).toEqual(['legacy-resume'])
    expect(restored?.recoveryBlocked).toBeUndefined()
  })

  test('an ambiguous legacy wake is retained until an explicit newer input resolves it', async () => {
    const sessionId = 'ambiguous-legacy-wake'
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write({ ...emptyEnvelope(sessionId, 10), acceptedThroughSeq: 2 })
    await ledger.recordRunnerEvent(sessionId, {
      type: 'sleep',
      wakeAt: 100,
      state: {
        status: 'sleeping',
        mode: 'agent',
        agent: { status: 'waiting', messages: [] },
      },
    })
    await ledger.acceptWake({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'ambiguous-wake',
    })
    await removeJournalOrderingMetadata(sessionId)
    const restarted = createAgentSessionLedger({ stateDir, now: () => 20 })
    const blocked = await restarted.read(sessionId)
    expect(blocked?.recoveryBlocked).toBe('ambiguous_legacy_wake')
    expect(blocked?.inFlightCommands).toEqual([
      { requestId: 'ambiguous-wake', command: { type: 'wake' } },
    ])
    await restarted.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'explicit-resume',
      throughSeq: 5,
      command: { type: 'prompt', message: 'continue explicitly', behavior: 'steer' },
    })
    const resolved = await createAgentSessionLedger({ stateDir, now: () => 30 }).read(sessionId)
    expect(resolved?.recoveryBlocked).toBeUndefined()
    expect(resolved?.inFlightCommands.map(item => item.requestId)).toEqual(['explicit-resume'])
    expect(resolved?.wake).toBeUndefined()
  })

  test('dropping a corrupt frontier record cannot replay older commits over accepted work', async () => {
    const sessionId = 'corrupt-materialized-frontier'
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write(emptyEnvelope(sessionId, 10))
    await ledger.recordRunnerEvent(sessionId, {
      type: 'interrupted',
      state: {
        status: 'interrupted',
        mode: 'agent',
        agent: { status: 'cancelled', messages: [] },
      },
    })
    await ledger.recordDurableSystemEvent(sessionId, {
      type: 'system',
      level: 'info',
      message: 'materialized frontier',
    })
    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'new-input',
      throughSeq: 5,
      command: { type: 'prompt', message: 'continue', behavior: 'steer' },
    })
    const path = join(dirname(sessionEnvelopePath(stateDir, sessionId)), 'relay-outbox.ndjson')
    const first = (await readFile(path, 'utf8')).split('\n')[0]
    await writeFile(path, first + '\n{corrupted frontier}\n')
    const restarted = createAgentSessionLedger({ stateDir, now: () => 20 })
    expect((await restarted.read(sessionId))?.inFlightCommands.map(item => item.requestId)).toEqual(
      ['new-input'],
    )
    await restarted.recordDurableSystemEvent(sessionId, {
      type: 'system',
      level: 'info',
      message: 'newer report',
    })
    const restored = await createAgentSessionLedger({ stateDir, now: () => 30 }).read(sessionId)
    expect(restored?.inFlightCommands.map(item => item.requestId)).toEqual(['new-input'])
    expect(restored?.relayOutbox.map(item => item.event)).toEqual([
      expect.objectContaining({ type: 'interrupted' }),
      { type: 'system', level: 'info', message: 'newer report' },
    ])
  })

  test('private checkpoint revisions distinguish a legacy completed wake from a later wake', async () => {
    const sessionId = 'legacy-revision-order'
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write({
      ...emptyEnvelope(sessionId, 10),
      acceptedThroughSeq: 2,
      checkpoint: {
        revision: 1,
        state: { status: 'running', mode: 'agent', agent: { status: 'running', messages: [] } },
      },
      inFlightCommands: [{ requestId: 'first-wake', command: { type: 'wake' } }],
    })
    await ledger.recordRunnerEvent(sessionId, {
      type: 'sleep',
      wakeAt: 100,
      state: {
        status: 'sleeping',
        mode: 'agent',
        agent: { status: 'waiting', messages: [] },
      },
    })
    await removeJournalOrderingMetadata(sessionId)
    const unmaterialized = createAgentSessionLedger({ stateDir, now: () => 20 })
    expect((await unmaterialized.read(sessionId))?.inFlightCommands).toEqual([])
    expect((await unmaterialized.read(sessionId))?.recoveryBlocked).toBeUndefined()
    await unmaterialized.acceptWake({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'later-wake',
    })
    const withLegacyFrontier = await createAgentSessionLedger({ stateDir, now: () => 25 }).read(
      sessionId,
    )
    expect(withLegacyFrontier?.inFlightCommands.map(item => item.requestId)).toEqual(['later-wake'])
    expect(withLegacyFrontier?.recoveryBlocked).toBeUndefined()
    await removeJournalOrderingMetadata(sessionId)
    const restored = await createAgentSessionLedger({ stateDir, now: () => 30 }).read(sessionId)
    expect(restored?.inFlightCommands.map(item => item.requestId)).toEqual(['later-wake'])
    expect(restored?.recoveryBlocked).toBeUndefined()
    expect(restored?.wake).toBeUndefined()
  })

  test('stopping a legacy ambiguity survives restart and keeps its native checkpoint', async () => {
    const sessionId = 'stop-legacy-ambiguity'
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write({ ...emptyEnvelope(sessionId, 10), acceptedThroughSeq: 2 })
    await ledger.recordRunnerEvent(sessionId, {
      type: 'sleep',
      wakeAt: 100,
      state: {
        status: 'sleeping',
        mode: 'agent',
        agent: { status: 'waiting', messages: [] },
      },
    })
    await ledger.acceptWake({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'ambiguous-wake',
    })
    await removeJournalOrderingMetadata(sessionId)
    const restarted = createAgentSessionLedger({ stateDir, now: () => 20 })
    const before = await restarted.read(sessionId)
    expect(before?.recoveryBlocked).toBe('ambiguous_legacy_wake')
    await restarted.settleInterrupt(sessionId)
    const restored = await createAgentSessionLedger({ stateDir, now: () => 30 }).read(sessionId)
    expect(restored?.checkpoint).toEqual(before?.checkpoint)
    expect(restored?.inFlightCommands).toEqual([])
    expect(restored?.recoveryBlocked).toBeUndefined()
    expect(restored?.wake).toBeUndefined()
  })

  test('a pending stop report cannot erase explicit resume after restart', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write({
      ...emptyEnvelope('stop-resume', 10),
      acceptedThroughSeq: 2,
      checkpoint: {
        terminalType: 'sleep',
        state: { status: 'sleeping', mode: 'agent', agent: { status: 'waiting', messages: [] } },
      },
      wake: { wakeAt: 100, generation: 1 },
    })
    await ledger.settleInterrupt('stop-resume')
    await ledger.acceptCommand({
      sessionId: 'stop-resume',
      launch: { tier: 'balanced' },
      requestId: 'resume',
      throughSeq: 5,
      command: { type: 'prompt', message: 'continue', behavior: 'steer' },
    })
    const restored = await createAgentSessionLedger({ stateDir, now: () => 20 }).read('stop-resume')
    expect(restored?.inFlightCommands).toEqual([
      {
        requestId: 'resume',
        throughSeq: 5,
        command: { type: 'prompt', message: 'continue', behavior: 'steer' },
      },
    ])
    expect(restored?.stoppedThroughSeq).toBeUndefined()
    expect(restored?.wake).toBeUndefined()
    expect(restored?.relayOutbox).toEqual([
      expect.objectContaining({
        acceptedThroughSeq: 2,
        event: expect.objectContaining({ metadata: { code: 'interrupt_undeliverable' } }),
      }),
    ])
  })

  test('a relay awaiting parent selection retains its obligation through terminal storage and restart', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write(emptyEnvelope('pending-transition', 10))
    const state = {
      status: 'waiting_for_human' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
      pendingStateTransition: { stateName: 'completed-work' },
    }
    await ledger.recordRunnerEvent('pending-transition', {
      type: 'ask',
      questions: [],
      state,
    })
    const restored = await createAgentSessionLedger({ stateDir, now: () => 20 }).read(
      'pending-transition',
    )
    expect(restored?.checkpoint?.state).toMatchObject({
      pendingStateTransition: { stateName: 'completed-work' },
    })
  })

  test('recovers a coherent live checkpoint without publishing private model context', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write(emptyEnvelope('live-checkpoint', 10))
    await ledger.recordRunnerEvent('live-checkpoint', {
      type: 'turn_started',
      state: { status: 'running', mode: 'auto', agent: { status: 'running', messages: [] } },
    })
    const state: AgentTurnState = {
      status: 'running',
      mode: 'auto',
      agent: {
        status: 'running',
        messages: [{ role: 'user', content: 'Finish the app', timestamp: 1 }],
      },
      tasks: [
        {
          id: 't37',
          kind: 'subagent',
          name: 'configure-runtime',
          label: 'Configure runtime',
          ownerScopeId: 'turn-1',
          status: 'running',
          startedAt: 10,
        },
      ],
      nextTaskId: 38,
    }
    await ledger.recordCheckpoint('live-checkpoint', state)
    const recovered = await createAgentSessionLedger({ stateDir, now: () => 20 }).read(
      'live-checkpoint',
    )
    expect(recovered?.checkpoint).toEqual({ state, revision: 1 })
    expect(recovered?.relayOutbox.map(item => item.event.type)).toEqual(['turn_started'])
  })

  test('checks relay identity in constant work as the journal grows', () => {
    let keyReads = 0
    const store = createRelayOutboxStore<{ id: string }>({
      pathForSession: sessionId => join(stateDir, sessionId, 'relay-outbox.ndjson'),
      parse: value => value as { id: string },
      key: record => {
        keyReads += 1
        return record.id
      },
      limits: { maxBytes: 1024 * 1024 },
      fsyncDirectory() {},
    })
    store.replace(
      'session-constant-append',
      Array.from({ length: 500 }, (_, index) => ({ id: `relay-${index}` })),
    )

    keyReads = 0
    store.append('session-constant-append', { id: 'relay-new' })

    expect(keyReads).toBe(1)
  })

  test('round-trips one private versioned session snapshot', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 1_700_000_000_000 })
    const envelope: GatewaySessionEnvelope = {
      version: 1 as const,
      sessionId: 'session/with unsafe path characters',
      agentAnchorId: 'anchor_agent_1',
      launch: { cwd: 'project', tier: 'balanced' as const },
      checkpoint: {
        state: {
          status: 'sleeping' as const,
          mode: 'agent' as const,
          agent: { status: 'waiting' as const, messages: [] },
          todos: [{ id: 'todo-1', content: 'Get milk', status: 'in_progress' as const }],
          followUpQueue: [{ message: 'Check the fridge' }],
        },
        terminalType: 'sleep' as const,
      },
      acceptedThroughSeq: 7,
      inFlightCommands: [
        {
          requestId: 'request-1',
          throughSeq: 7,
          command: { type: 'prompt' as const, message: 'Get milk', behavior: 'follow_up' as const },
        },
      ],
      wake: { wakeAt: 1_700_000_060_000, generation: 2 },
      relayOutbox: [],
      updatedAt: 1_700_000_000_000,
    }

    await ledger.write(envelope)

    const path = sessionEnvelopePath(stateDir, envelope.sessionId)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await Bun.file(path).text())).not.toHaveProperty('relayOutbox')
    expect((await readdir(dirname(path))).sort()).toEqual(['session.json'])
    expect(
      await createAgentSessionLedger({ stateDir, now: () => 0 }).read(envelope.sessionId),
    ).toEqual(envelope)
  })

  test('loads healthy sessions while preserving a corrupt session for inspection', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 10 })
    await ledger.write(emptyEnvelope('healthy', 10))
    const corruptPath = sessionEnvelopePath(stateDir, 'corrupt')
    await mkdir(dirname(corruptPath), { recursive: true })
    await writeFile(corruptPath, '{"version":1,"truncated":')

    const loaded = await ledger.loadAll()

    expect(loaded.sessions).toEqual([emptyEnvelope('healthy', 10)])
    expect(loaded.corrupt).toEqual([
      {
        path: corruptPath,
        error: expect.stringContaining('JSON'),
      },
    ])
    expect(await stat(corruptPath)).toBeDefined()
  })

  test('durably accepts a command and cursor before acknowledging it', async () => {
    let now = 20
    const ledger = createAgentSessionLedger({ stateDir, now: () => now })
    const input = {
      sessionId: 'session-accept',
      launch: { cwd: 'project', tier: 'balanced' as const },
      requestId: 'request-accept',
      throughSeq: 4,
      command: { type: 'prompt' as const, message: 'Continue', behavior: 'steer' as const },
    }

    const accepted = await ledger.acceptCommand(input)

    expect(accepted).toMatchObject({
      acceptedThroughSeq: 4,
      inFlightCommands: [
        {
          requestId: 'request-accept',
          throughSeq: 4,
          command: { type: 'prompt', message: 'Continue', behavior: 'steer' },
        },
      ],
      updatedAt: 20,
    })
    expect(
      await createAgentSessionLedger({ stateDir, now: () => 30 }).read(input.sessionId),
    ).toEqual(accepted)
    now = 21
    expect(await ledger.acceptCommand(input)).toEqual(accepted)
    await expect(
      ledger.acceptCommand({
        ...input,
        command: { type: 'prompt', message: 'Different', behavior: 'steer' },
      }),
    ).rejects.toThrow('request id was reused')
  })

  // Both MCP fields are permission boundaries, and both fail closed: a turn
  // that names no servers has none. Riding along newest-wins would resurrect a
  // server the user removed from the on-disk envelope and keep it forever,
  // because every later turn re-merges the same envelope.
  test('a turn that names no MCP servers drops the ones a previous turn had', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 60 })
    const sessionId = 'session-mcp-fail-closed'
    const withServers = await ledger.acceptCommand({
      sessionId,
      launch: {
        cwd: 'project',
        tier: 'balanced' as const,
        integrations: true as const,
        mcpServers: [{ name: 'notes' }, { name: 'tickets' }],
      },
      requestId: 'request-with-servers',
      throughSeq: 1,
      command: { type: 'prompt' as const, message: 'first', behavior: 'steer' as const },
    })
    expect(withServers.launch.mcpServers).toEqual([{ name: 'notes' }, { name: 'tickets' }])

    const withoutServers = await ledger.acceptCommand({
      sessionId,
      launch: { cwd: 'project', tier: 'balanced' as const },
      requestId: 'request-without-servers',
      throughSeq: 2,
      command: { type: 'prompt' as const, message: 'second', behavior: 'steer' as const },
    })

    expect(withoutServers.launch).toEqual({ cwd: 'project', tier: 'balanced' })
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 61 }).read(sessionId))?.launch,
    ).toEqual({ cwd: 'project', tier: 'balanced' })
  })

  // The removal has to survive a reload, not just the turn that made it: the
  // envelope on disk is what a wake or a crash recovery relaunches from.
  test('one removed MCP server leaves the others in place', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 70 })
    const sessionId = 'session-mcp-partial-removal'
    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' as const, mcpServers: [{ name: 'notes' }, { name: 'tickets' }] },
      requestId: 'request-both',
      throughSeq: 1,
      command: { type: 'prompt' as const, message: 'first', behavior: 'steer' as const },
    })

    await ledger.acceptCommand({
      sessionId,
      launch: { tier: 'balanced' as const, mcpServers: [{ name: 'tickets' }] },
      requestId: 'request-one',
      throughSeq: 2,
      command: { type: 'prompt' as const, message: 'second', behavior: 'steer' as const },
    })

    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 71 }).read(sessionId))?.launch,
    ).toEqual({ tier: 'balanced', mcpServers: [{ name: 'tickets' }] })
  })

  test('settling a prompt as storage-full preserves its scheduled wake', async () => {
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 35,
      createRelayId: () => 'relay-storage-full',
    })
    await ledger.write({
      ...emptyEnvelope('session-storage-full-wake', 10),
      wake: { wakeAt: 100, generation: 2 },
    })

    const settled = await ledger.settleInput({
      sessionId: 'session-storage-full-wake',
      launch: { tier: 'balanced' },
      throughSeq: 1,
      event: { type: 'system', level: 'error', message: 'Workspace full' },
    })

    expect(settled.wake).toEqual({ wakeAt: 100, generation: 2 })
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 40 }).read(settled.sessionId))?.wake,
    ).toEqual({ wakeAt: 100, generation: 2 })
  })

  test('later inputs update the tier but can never change launch identity', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 40 })
    const sessionId = 'session-launch-identity'
    const startMode = {
      name: 'original-mode',
      prompt: 'Run the original mode.',
      states: [{ name: 'done', kind: 'terminal' as const, status: 'completed' as const }],
    }
    await ledger.acceptCommand({
      sessionId,
      launch: { cwd: 'agents/ads', tier: 'balanced', onboarding: true, mode: startMode },
      requestId: 'request-1',
      throughSeq: 1,
      command: { type: 'prompt' as const, message: 'Start', behavior: 'steer' as const },
    })

    // Switching tier mid-session must reach the persisted envelope: the wake and
    // recovery paths relaunch from `envelope.launch.tier`, so a frozen
    // launch would silently resurrect the tier the user already moved off.
    const updated = await ledger.acceptCommand({
      sessionId,
      launch: {
        cwd: 'agents/ads',
        tier: 'frontier',
        mode: {
          name: 'replacement-mode',
          prompt: 'Run a different mode.',
          states: [{ name: 'done', kind: 'terminal' as const, status: 'completed' as const }],
        },
      },
      requestId: 'request-2',
      throughSeq: 2,
      command: { type: 'prompt' as const, message: 'Continue', behavior: 'steer' as const },
    })
    expect(updated.launch.tier).toBe('frontier')

    // ...while launch identity stays fixed at what creation established. Any
    // later request omitting or flipping it must not move the session's system
    // prompt or state-machine definition.
    expect(updated.launch.onboarding).toBe(true)
    expect(updated.launch.mode).toEqual(startMode)

    const reopened = await createAgentSessionLedger({ stateDir, now: () => 41 }).read(sessionId)
    expect(reopened?.launch).toMatchObject({
      tier: 'frontier',
      onboarding: true,
      mode: startMode,
    })
  })

  test('read-and-rewrite strips unknown top-level fields generically', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 20 })
    await ledger.write({
      ...emptyEnvelope('session-loose-envelope', 10),
      futureEnvelopeKey: { retained: true },
      launch: {
        tier: 'balanced',
        onboarding: true,
        futureLaunchKey: 'retained',
      },
      checkpoint: {
        state: {
          status: 'running',
          mode: 'agent',
          agent: { status: 'running', messages: [] },
        },
        futureCheckpointKey: 'retained',
      },
      acceptedThroughSeq: 1,
      inFlightCommands: [
        {
          requestId: 'request-before-read',
          throughSeq: 1,
          command: { type: 'prompt', message: 'Start', behavior: 'steer' },
          futureCommandKey: 'retained',
        },
      ],
      wake: { wakeAt: 100, generation: 1, futureWakeKey: 'retained' },
      relayOutbox: [],
    } as unknown as GatewaySessionEnvelope)

    await ledger.acceptCommand({
      sessionId: 'session-loose-envelope',
      launch: { tier: 'balanced' },
      requestId: 'request-after-read',
      throughSeq: 1,
      command: { type: 'prompt', message: 'Continue', behavior: 'steer' },
    })

    const rewritten = await ledger.read('session-loose-envelope')
    expect(rewritten).toMatchObject({
      launch: {
        onboarding: true,
        futureLaunchKey: 'retained',
      },
      checkpoint: { futureCheckpointKey: 'retained' },
      wake: { futureWakeKey: 'retained' },
    })
    expect(rewritten).not.toHaveProperty('futureEnvelopeKey')
    expect(rewritten?.inFlightCommands[0]).toMatchObject({ futureCommandKey: 'retained' })
  })

  test('setLaunchCwd changes only launch.cwd and survives reopening the ledger', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 20 })
    const before = {
      ...emptyEnvelope('session-set-cwd', 10),
      futureEnvelopeKey: { retained: true },
      launch: {
        cwd: 'one',
        tier: 'balanced',
        onboarding: true,
        futureLaunchKey: 'retained',
      },
      checkpoint: {
        state: {
          status: 'running' as const,
          mode: 'agent' as const,
          agent: { status: 'running' as const, messages: [] },
        },
        futureCheckpointKey: 'retained',
      },
      wake: { wakeAt: 100, generation: 1, futureWakeKey: 'retained' },
    } as unknown as GatewaySessionEnvelope
    await ledger.write(before)

    const accepted = await ledger.setLaunchCwd(before.sessionId, 'two')
    const { futureEnvelopeKey: _ignored, ...knownBefore } = before

    expect(accepted).toEqual({
      ...knownBefore,
      launch: { ...before.launch, cwd: 'two' },
    })
    expect(
      await createAgentSessionLedger({ stateDir, now: () => 999 }).read(before.sessionId),
    ).toEqual(accepted)
  })

  test('drops a persisted wake claim from a live VM while retaining other wake fields', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 25 })
    const envelope = {
      ...emptyEnvelope('session-stale-wake-claim', 10),
      wake: {
        wakeAt: 100,
        generation: 2,
        claim: 'gateway-before-upgrade',
        futureWakeKey: 'retained',
      },
    }
    const path = sessionEnvelopePath(stateDir, envelope.sessionId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(envelope))

    const parsedWake = (await ledger.read(envelope.sessionId))?.wake
    expect(parsedWake as Record<string, unknown>).toEqual({
      wakeAt: 100,
      generation: 2,
      futureWakeKey: 'retained',
    })
  })

  test('commits terminal state, wake generation, and relay outbox together', async () => {
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 30,
      createRelayId: () => 'relay-sleep',
    })
    await ledger.acceptCommand({
      sessionId: 'session-sleep',
      launch: { tier: 'balanced' },
      requestId: 'request-before-sleep',
      throughSeq: 1,
      command: { type: 'prompt', message: 'Get milk', behavior: 'steer' },
    })
    const state = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
      todos: [{ id: 'todo-1', content: 'Get milk', status: 'pending' as const }],
      followUpQueue: [{ message: 'Buy oat milk' }],
    }

    const committed = await ledger.recordRunnerEvent('session-sleep', {
      type: 'sleep',
      state,
      wakeAt: 1_700_000_060_000,
    })

    expect(committed).toMatchObject({
      checkpoint: { state, terminalType: 'sleep' },
      inFlightCommands: [],
      wake: { wakeAt: 1_700_000_060_000, generation: 1 },
      updatedAt: 30,
    })
    expect(
      await createAgentSessionLedger({ stateDir, now: () => 0 }).read('session-sleep'),
    ).toEqual({
      ...committed,
      relayOutbox: [
        {
          relayId: 'relay-sleep',
          event: { type: 'sleep', state, wakeAt: 1_700_000_060_000 },
          acceptedThroughSeq: 1,
        },
      ],
    })
  })

  test('a new sleep supersedes the wake consumed by an accepted dispatch', async () => {
    let relay = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 31,
      createRelayId: () => `relay-sleep-${++relay}`,
    })
    const sessionId = 'session-sleep-supersedes-wake'
    await ledger.write({
      ...emptyEnvelope(sessionId, 10),
      wake: { wakeAt: 100, generation: 2 },
    })
    const state = {
      status: 'sleeping' as const,
      mode: 'agent' as const,
      agent: { status: 'waiting' as const, messages: [] },
    }

    const accepted = await ledger.acceptWake({
      sessionId,
      launch: { tier: 'balanced' },
      requestId: 'accepted-wake',
    })
    expect(accepted.wake).toBeUndefined()
    expect(accepted.inFlightCommands).toEqual([
      { requestId: 'accepted-wake', command: { type: 'wake' } },
    ])

    const rescheduled = await ledger.recordRunnerEvent(sessionId, {
      type: 'sleep',
      state,
      wakeAt: 200,
    })
    expect(rescheduled.wake).toEqual({ wakeAt: 200, generation: 1 })
    expect((await ledger.read(sessionId))?.wake).toEqual({ wakeAt: 200, generation: 1 })
  })

  test('retries the stable relay id in order and removes it only after receipt', async () => {
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => 'relay-stable',
    })
    await ledger.write(emptyEnvelope('session-relay', 10))
    const state = {
      status: 'completed' as const,
      mode: 'agent' as const,
      agent: { status: 'completed' as const, messages: [] },
    }
    await ledger.recordRunnerEvent('session-relay', {
      type: 'complete',
      state,
      status: 'completed',
      result: 'Remember the milk',
    })
    const attempts: string[] = []

    await expect(
      ledger.drainRelayOutbox('session-relay', item => {
        attempts.push(item.relayId)
        return Promise.reject(new Error('backend unavailable'))
      }),
    ).rejects.toThrow('backend unavailable')
    expect(await ledger.read('session-relay')).toMatchObject({
      checkpoint: { state, terminalType: 'complete' },
      relayOutbox: [{ relayId: 'relay-stable', event: { type: 'complete' } }],
    })

    const receipts = await createAgentSessionLedger({ stateDir, now: () => 50 }).drainRelayOutbox(
      'session-relay',
      async item => {
        attempts.push(item.relayId)
        return { relayId: item.relayId, seq: 12 }
      },
    )

    expect(attempts).toEqual(['relay-stable', 'relay-stable'])
    expect(receipts).toEqual([{ relayId: 'relay-stable', seq: 12 }])
    expect((await ledger.read('session-relay'))?.relayOutbox).toEqual([])
  })

  test('appends relay events without replacing the session snapshot', async () => {
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => 'relay-appended',
    })
    const sessionId = 'session-appended-relay'
    await ledger.write(emptyEnvelope(sessionId, 10))
    const path = sessionEnvelopePath(stateDir, sessionId)
    const before = await stat(path)

    await ledger.recordRunnerEvent(sessionId, {
      type: 'step',
      step: { type: 'text', text: 'durable output' },
    })

    const after = await stat(path)
    expect(after.ino).toBe(before.ino)
    expect(
      (await createAgentSessionLedger({ stateDir, now: () => 50 }).read(sessionId))?.relayOutbox,
    ).toEqual([
      {
        relayId: 'relay-appended',
        event: { type: 'step', step: { type: 'text', text: 'durable output' } },
        acceptedThroughSeq: 0,
      },
    ])
  })

  test('folds only the new commit when appending to a warm relay backlog', async () => {
    let relay = 0
    let folds = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => `relay-fold-${++relay}`,
      onRelayCommitFold: () => {
        folds += 1
      },
    })
    const sessionId = 'session-folded-state-cache'
    await ledger.write(emptyEnvelope(sessionId, 10))
    for (let index = 0; index < 32; index += 1) {
      await ledger.recordRunnerEvent(sessionId, {
        type: 'step',
        step: { type: 'text', text: `backlog ${index}` },
      })
    }
    folds = 0

    await ledger.recordRunnerEvent(sessionId, {
      type: 'step',
      step: { type: 'text', text: 'one more' },
    })

    expect(folds).toBe(1)
    expect((await ledger.read(sessionId))?.relayOutbox).toHaveLength(33)
  })

  test('does not retain empty relay journals while loading historical sessions', async () => {
    let cachedEntries = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      onRelayOutboxCacheEntriesChanged: entries => {
        cachedEntries = entries
      },
    })
    for (let index = 0; index < 16; index += 1) {
      await ledger.write(emptyEnvelope(`historical-session-${index}`, 10))
    }

    await ledger.loadAll()

    expect(cachedEntries).toBe(0)
  })

  test('compacts a successful receipt prefix once when the next relay fails', async () => {
    let relay = 0
    const seeded = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => `relay-batch-${++relay}`,
    })
    const sessionId = 'session-batched-receipts'
    await seeded.write(emptyEnvelope(sessionId, 10))
    for (const text of ['one', 'two', 'three', 'four']) {
      await seeded.recordRunnerEvent(sessionId, {
        type: 'step',
        step: { type: 'text', text },
      })
    }

    let renames = 0
    const draining = createAgentSessionLedger({
      stateDir,
      now: () => 50,
      operations: {
        ...defaultAtomicJsonOperations,
        rename(from, to) {
          renames += 1
          defaultAtomicJsonOperations.rename(from, to)
        },
      },
    })
    await expect(
      draining.drainRelayOutbox(sessionId, async item => {
        if (item.relayId === 'relay-batch-4') throw new Error('backend unavailable')
        return { relayId: item.relayId, seq: Number(item.relayId.at(-1)) }
      }),
    ).rejects.toThrow('backend unavailable')

    expect(renames).toBe(2)
    expect((await draining.read(sessionId))?.relayOutbox).toEqual([
      {
        relayId: 'relay-batch-4',
        event: { type: 'step', step: { type: 'text', text: 'four' } },
        acceptedThroughSeq: 0,
      },
    ])
  })

  test('drains events appended while an active relay batch is in flight', async () => {
    let relay = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 50,
      createRelayId: () => `relay-concurrent-${++relay}`,
    })
    const sessionId = 'session-concurrent-relay'
    await ledger.write(emptyEnvelope(sessionId, 10))
    await ledger.recordRunnerEvent(sessionId, {
      type: 'step',
      step: { type: 'text', text: 'first' },
    })
    const relayed: string[] = []

    const receipts = await ledger.drainRelayOutbox(sessionId, async item => {
      relayed.push(item.relayId)
      if (item.relayId === 'relay-concurrent-1') {
        await ledger.recordRunnerEvent(sessionId, {
          type: 'step',
          step: { type: 'text', text: 'arrived during relay' },
        })
      }
      return { relayId: item.relayId, seq: relayed.length }
    })

    expect(relayed).toEqual(['relay-concurrent-1', 'relay-concurrent-2'])
    expect(receipts.map(receipt => receipt.relayId)).toEqual(relayed)
    expect((await ledger.read(sessionId))?.relayOutbox).toEqual([])
  })

  test('rejects a relay past the byte ceiling without disturbing the backlog', async () => {
    let relay = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => `relay-cap-${++relay}`,
      relayOutboxLimits: { maxBytes: 4096 },
    })
    const sessionId = 'session-relay-byte-cap-backlog'
    await ledger.write(emptyEnvelope(sessionId, 10))
    for (const text of ['one', 'two']) {
      await ledger.recordRunnerEvent(sessionId, {
        type: 'step',
        step: { type: 'text', text },
      })
    }

    await expect(
      ledger.recordRunnerEvent(sessionId, {
        type: 'step',
        step: { type: 'text', text: 'x'.repeat(20_000) },
      }),
    ).rejects.toEqual(new AgentRelayOutboxCapacityError())

    expect((await ledger.read(sessionId))?.relayOutbox.map(item => item.event)).toEqual([
      { type: 'step', step: { type: 'text', text: 'one' } },
      { type: 'step', step: { type: 'text', text: 'two' } },
    ])
  })

  test('rejects the first relay when its durable record cannot fit at all', async () => {
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => 'relay-byte-cap',
      relayOutboxLimits: { maxBytes: 1 },
    })
    const sessionId = 'session-relay-byte-cap'
    await ledger.write(emptyEnvelope(sessionId, 10))

    await expect(
      ledger.recordRunnerEvent(sessionId, {
        type: 'step',
        step: { type: 'text', text: 'cannot fit' },
      }),
    ).rejects.toEqual(new AgentRelayOutboxCapacityError())
    expect((await ledger.read(sessionId))?.relayOutbox).toEqual([])
  })

  test('boot loading folds journaled relay state before recovery decisions', async () => {
    const sessionId = 'session-boot-outbox'
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => 'relay-at-boot',
    })
    await ledger.write(emptyEnvelope(sessionId, 10))
    const state = {
      status: 'completed' as const,
      mode: 'agent' as const,
      agent: { status: 'completed' as const, messages: [] },
    }
    await ledger.recordRunnerEvent(sessionId, {
      type: 'complete',
      state,
      status: 'completed',
      result: 'done before restart',
    })

    const loaded = await createAgentSessionLedger({ stateDir, now: () => 50 }).loadAll()
    expect(loaded.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        checkpoint: { state, terminalType: 'complete' },
        relayOutbox: [
          expect.objectContaining({
            relayId: 'relay-at-boot',
            event: expect.objectContaining({ type: 'complete', result: 'done before restart' }),
          }),
        ],
      }),
    ])
  })

  test('restart discards only a crash-truncated final journal append', async () => {
    const sessionId = 'session-truncated-append'
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => 'relay-before-crash',
    })
    await ledger.write(emptyEnvelope(sessionId, 10))
    await ledger.recordRunnerEvent(sessionId, {
      type: 'step',
      step: { type: 'text', text: 'committed before crash' },
    })
    const outboxPath = join(
      dirname(sessionEnvelopePath(stateDir, sessionId)),
      'relay-outbox.ndjson',
    )
    await appendFile(outboxPath, '{"version":1,"item":')

    const restarted = createAgentSessionLedger({ stateDir, now: () => 50 })
    expect((await restarted.read(sessionId))?.relayOutbox).toEqual([
      {
        relayId: 'relay-before-crash',
        event: { type: 'step', step: { type: 'text', text: 'committed before crash' } },
        acceptedThroughSeq: 0,
      },
    ])
    expect(await Bun.file(outboxPath).text()).toEndWith('\n')
  })

  // Damage is not always the last append: a torn write leaves a committed,
  // newline-terminated record unreadable in the MIDDLE of the journal, which
  // the truncated-tail rule above cannot see. Those bytes are gone either way;
  // what must not happen is the whole session going unreadable with them.
  test('restart drops journal records lost to a NUL hole and keeps the session readable', async () => {
    const sessionId = 'session-nul-hole'
    let relay = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => `relay-${(relay += 1)}`,
    })
    await ledger.write(emptyEnvelope(sessionId, 10))
    for (const text of ['before the hole', 'lost to the hole', 'after the hole']) {
      await ledger.recordRunnerEvent(sessionId, { type: 'step', step: { type: 'text', text } })
    }
    const outboxPath = join(
      dirname(sessionEnvelopePath(stateDir, sessionId)),
      'relay-outbox.ndjson',
    )
    const lines = (await Bun.file(outboxPath).text()).split('\n')
    lines[1] = '\0'.repeat(lines[1]!.length)
    await writeFile(outboxPath, lines.join('\n'))

    const restarted = createAgentSessionLedger({ stateDir, now: () => 50 })

    expect((await restarted.read(sessionId))?.relayOutbox).toEqual([
      {
        relayId: 'relay-1',
        event: { type: 'step', step: { type: 'text', text: 'before the hole' } },
        acceptedThroughSeq: 0,
      },
      {
        relayId: 'relay-3',
        event: { type: 'step', step: { type: 'text', text: 'after the hole' } },
        acceptedThroughSeq: 0,
      },
    ])
  })

  test('freezes terminal coverage before later input and preserves it across restart', async () => {
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 40,
      createRelayId: () => 'relay-terminal-4',
    })
    await ledger.write({ ...emptyEnvelope('session-covered-terminal', 10), acceptedThroughSeq: 4 })
    await ledger.recordRunnerEvent('session-covered-terminal', {
      type: 'complete',
      state: {
        status: 'completed',
        mode: 'agent',
        agent: { status: 'completed', messages: [] },
      },
      status: 'completed',
      result: 'done through four',
    })
    await ledger.acceptCommand({
      sessionId: 'session-covered-terminal',
      launch: { tier: 'balanced' },
      requestId: 'request-five',
      throughSeq: 5,
      command: { type: 'prompt', message: 'five', behavior: 'follow_up' },
    })

    const restarted = createAgentSessionLedger({ stateDir, now: () => 50 })
    expect(await restarted.read('session-covered-terminal')).toMatchObject({
      acceptedThroughSeq: 5,
      relayOutbox: [
        {
          relayId: 'relay-terminal-4',
          acceptedThroughSeq: 4,
          event: { type: 'complete', result: 'done through four' },
        },
      ],
    })

    const relayedCoverage: Array<number | undefined> = []
    await restarted.drainRelayOutbox('session-covered-terminal', async item => {
      relayedCoverage.push(item.acceptedThroughSeq)
      return { relayId: item.relayId, seq: 11 }
    })
    expect(relayedCoverage).toEqual([4])
  })

  test('keeps the previous envelope and removes staging debris when rename fails', async () => {
    const stable = createAgentSessionLedger({ stateDir, now: () => 10 })
    await stable.write(emptyEnvelope('session-atomic', 10))
    const failing = createAgentSessionLedger({
      stateDir,
      now: () => 20,
      operations: {
        ...defaultAtomicJsonOperations,
        rename() {
          throw new Error('rename injected')
        },
      },
    })

    await expect(failing.write(emptyEnvelope('session-atomic', 20))).rejects.toThrow(
      'rename injected',
    )

    expect(await stable.read('session-atomic')).toEqual(emptyEnvelope('session-atomic', 10))
    expect(await readdir(dirname(sessionEnvelopePath(stateDir, 'session-atomic')))).toEqual([
      'session.json',
    ])
  })

  test('keeps the previous envelope and removes a partial file when writing fails', async () => {
    const stable = createAgentSessionLedger({ stateDir, now: () => 10 })
    await stable.write(emptyEnvelope('session-write', 10))
    const failing = createAgentSessionLedger({
      stateDir,
      now: () => 20,
      operations: {
        ...defaultAtomicJsonOperations,
        write(fileDescriptor) {
          defaultAtomicJsonOperations.write(fileDescriptor, '{"partial":')
          throw new Error('write injected')
        },
      },
    })

    await expect(failing.write(emptyEnvelope('session-write', 20))).rejects.toThrow(
      'write injected',
    )

    expect(await stable.read('session-write')).toEqual(emptyEnvelope('session-write', 10))
    expect(await readdir(dirname(sessionEnvelopePath(stateDir, 'session-write')))).toEqual([
      'session.json',
    ])
  })

  test('exposes only the old or renamed envelope across fsync failures', async () => {
    const stable = createAgentSessionLedger({ stateDir, now: () => 10 })
    await stable.write(emptyEnvelope('session-fsync', 10))
    let fileFsyncs = 0
    const failFileFsync = createAgentSessionLedger({
      stateDir,
      now: () => 20,
      operations: {
        ...defaultAtomicJsonOperations,
        fsync(fileDescriptor) {
          fileFsyncs += 1
          if (fileFsyncs === 1) throw new Error('file fsync injected')
          defaultAtomicJsonOperations.fsync(fileDescriptor)
        },
      },
    })

    await expect(failFileFsync.write(emptyEnvelope('session-fsync', 20))).rejects.toThrow(
      'file fsync injected',
    )
    expect(await stable.read('session-fsync')).toEqual(emptyEnvelope('session-fsync', 10))

    let directoryFsyncs = 0
    const failDirectoryFsync = createAgentSessionLedger({
      stateDir,
      now: () => 30,
      operations: {
        ...defaultAtomicJsonOperations,
        fsync(fileDescriptor) {
          directoryFsyncs += 1
          if (directoryFsyncs === 2) throw new Error('directory fsync injected')
          defaultAtomicJsonOperations.fsync(fileDescriptor)
        },
      },
    })
    await expect(failDirectoryFsync.write(emptyEnvelope('session-fsync', 30))).rejects.toThrow(
      'directory fsync injected',
    )

    expect(await stable.read('session-fsync')).toEqual(emptyEnvelope('session-fsync', 30))
    expect(await readdir(dirname(sessionEnvelopePath(stateDir, 'session-fsync')))).toEqual([
      'session.json',
    ])
  })

  test('finishes discard after losing the tombstone commit acknowledgement', async () => {
    const stable = createAgentSessionLedger({ stateDir, now: () => 10 })
    await stable.write(emptyEnvelope('session-discard-fsync', 10))
    let fsyncs = 0
    const losingAcknowledgement = createAgentSessionLedger({
      stateDir,
      now: () => 20,
      operations: {
        ...defaultAtomicJsonOperations,
        fsync(fileDescriptor) {
          defaultAtomicJsonOperations.fsync(fileDescriptor)
          fsyncs += 1
          if (fsyncs === 2) throw new Error('tombstone acknowledgement lost')
        },
      },
    })

    await expect(losingAcknowledgement.discard('session-discard-fsync')).resolves.toBe(true)

    expect(await stable.read('session-discard-fsync')).toBeNull()
    expect((await stable.loadAll()).sessions).toEqual([])
    await expect(stable.write(emptyEnvelope('session-discard-fsync', 30))).rejects.toThrow(
      'discarded',
    )
  })

  test('retains input documents without advancing recovery from a state-machine display event', async () => {
    let relay = 0
    const ledger = createAgentSessionLedger({
      stateDir,
      now: () => 50,
      createRelayId: () => `relay-${++relay}`,
    })
    await ledger.write(emptyEnvelope('session-documents', 10))
    await ledger.recordRunnerEvent('session-documents', {
      type: 'turn_started',
      state: {
        status: 'running',
        mode: 'agent',
        agent: { status: 'running', messages: [] },
      },
    })
    const todos = [{ id: 'todo-1', content: 'Buy milk', status: 'in_progress' as const }]
    const followUpQueue = [
      { message: 'Ask which milk', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] },
    ]
    const stateMachine = {
      definition: {
        name: 'milk-reminder',
        prompt: 'Remind the user',
        states: [{ kind: 'timer' as const, name: 'wait-one-hour', wakeAfterMs: 3_600_000 }],
      },
      prompt: 'Get milk',
      currentState: 'wait-one-hour',
      currentInput: { source: 'user' },
      progress: {
        states: { 'wait-one-hour': { kind: 'timer' as const, runs: 1, sleeps: 0 } },
      },
      history: [{ type: 'state_started' as const, timestamp: 1, state: 'wait-one-hour' }],
      createdAt: 1,
      updatedAt: 2,
    }
    await ledger.recordRunnerEvent('session-documents', { type: 'todos', todos })
    await ledger.recordRunnerEvent('session-documents', { type: 'follow_up_queue', followUpQueue })
    await ledger.recordRunnerEvent('session-documents', { type: 'state_machine', stateMachine })

    const restarted = await createAgentSessionLedger({ stateDir, now: () => 0 }).read(
      'session-documents',
    )

    expect(restarted?.checkpoint?.state).toEqual({
      status: 'running',
      mode: 'agent',
      agent: { status: 'running', messages: [] },
      todos,
      followUpQueue,
    })
  })

  test('serializes concurrent mutations without losing either accepted command', async () => {
    let now = 60
    const ledger = createAgentSessionLedger({ stateDir, now: () => now++ })
    const launch = { tier: 'balanced' as const }

    await Promise.all([
      ledger.acceptCommand({
        sessionId: 'session-concurrent',
        launch,
        requestId: 'request-one',
        throughSeq: 1,
        command: { type: 'prompt', message: 'one', behavior: 'steer' },
      }),
      ledger.acceptCommand({
        sessionId: 'session-concurrent',
        launch,
        requestId: 'request-two',
        throughSeq: 2,
        command: { type: 'prompt', message: 'two', behavior: 'follow_up' },
      }),
    ])

    expect(await ledger.read('session-concurrent')).toMatchObject({
      acceptedThroughSeq: 2,
      inFlightCommands: [
        { requestId: 'request-one', command: { message: 'one', behavior: 'steer' } },
        { requestId: 'request-two', command: { message: 'two', behavior: 'follow_up' } },
      ],
    })
  })

  test('rejects duplicate durable ids and command cursors beyond acceptance', async () => {
    const ledger = createAgentSessionLedger({ stateDir, now: () => 70 })
    const command = {
      requestId: 'request-duplicate',
      throughSeq: 1,
      command: { type: 'prompt' as const, message: 'one', behavior: 'steer' as const },
    }
    await expect(
      ledger.write({
        ...emptyEnvelope('session-duplicate-command', 70),
        acceptedThroughSeq: 1,
        inFlightCommands: [command, command],
      }),
    ).rejects.toThrow('duplicate agent command request id')

    await expect(
      ledger.write({
        ...emptyEnvelope('session-impossible-cursor', 70),
        acceptedThroughSeq: 1,
        inFlightCommands: [{ ...command, requestId: 'request-ahead', throughSeq: 2 }],
      }),
    ).rejects.toThrow('agent command cursor exceeds accepted cursor')
  })
})

function emptyEnvelope(sessionId: string, updatedAt: number): GatewaySessionEnvelope {
  return {
    version: 1 as const,
    sessionId,
    launch: { tier: 'balanced' },
    acceptedThroughSeq: 0,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt,
  }
}

// The control plane projects todos, the follow-up queue, and the state machine
// off a terminal's state, and reads nothing else on it. The transcript is the
// runner's own working memory: shipping it bought the control plane nothing
// and killed the mutation that had to parse it, jamming a live workspace on a
// terminal it could never accept (2026-08-19).
test('a terminal relays without the transcript its checkpoint keeps', async () => {
  const sessionId = 'session-terminal-transcript'
  const ledger = createAgentSessionLedger({ stateDir, now: () => 40 })
  await ledger.write(emptyEnvelope(sessionId, 10))
  // Only the weight matters here, not the message shape the runner really writes.
  const messages = [
    { role: 'assistant', content: 'A'.repeat(600 * 1024) },
  ] as unknown as AgentTurnState['agent']['messages']
  const state = {
    status: 'completed' as const,
    mode: 'agent' as const,
    agent: { status: 'completed' as const, messages },
    todos: [{ id: 'ship', content: 'Ship it', status: 'completed' as const }],
  }

  await ledger.recordRunnerEvent(sessionId, {
    type: 'complete',
    state,
    status: 'completed',
    result: 'Done',
  })

  const envelope = await ledger.read(sessionId)
  const checkpointed = envelope?.checkpoint?.state.agent.messages
  expect(envelope?.relayOutbox[0]?.event).toMatchObject({
    type: 'complete',
    state: { agent: { messages: [] }, todos: [{ id: 'ship' }] },
  })
  // What the agent resumes from is untouched: the wire is the only thing that
  // loses the transcript.
  expect(checkpointed).toEqual(messages)
})

// The journal is the one place an event is held for the control plane, so it
// is the one place the budget has to hold — on the way in for events this
// gateway records, and on the way back out for records an older one left
// behind. A live workspace jammed on exactly the second case (2026-08-17).
test('an oversized event is journaled within the relay budget', async () => {
  const sessionId = 'session-oversized-event'
  const ledger = createAgentSessionLedger({
    stateDir,
    now: () => 40,
    createRelayId: () => 'relay-1',
  })
  await ledger.write(emptyEnvelope(sessionId, 10))

  await ledger.recordRunnerEvent(sessionId, {
    type: 'step',
    step: {
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'call_1',
      input: { path: 'ads/story-b.png' },
      isError: false,
      output: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(1_353_092) },
      ],
    },
  })

  const relayed = (await ledger.read(sessionId))?.relayOutbox[0]?.event
  expect(JSON.stringify(relayed).length).toBeLessThan(CONVEX_EVENT_BUDGET_BYTES)
  expect(relayed).toMatchObject({
    step: {
      output: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'text', text: '[image omitted — 1.3 MB image/png]' },
      ],
    },
  })
})

test('a record left oversized by an older gateway is normalized and compacted on load', async () => {
  const sessionId = 'session-legacy-oversized'
  const outboxPath = join(dirname(sessionEnvelopePath(stateDir, sessionId)), 'relay-outbox.ndjson')
  await mkdir(dirname(outboxPath), { recursive: true })
  await createAgentSessionLedger({ stateDir, now: () => 10 }).write(emptyEnvelope(sessionId, 10))
  await writeFile(
    outboxPath,
    `${JSON.stringify({
      version: 1,
      item: {
        relayId: 'relay-from-before',
        event: {
          type: 'step',
          step: {
            type: 'tool_call',
            toolName: 'read',
            toolCallId: 'call_1',
            input: {},
            isError: false,
            output: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(1_353_092) }],
          },
        },
        acceptedThroughSeq: 0,
      },
      commit: { updatedAt: 20 },
    })}\n`,
  )

  const loaded = await createAgentSessionLedger({ stateDir, now: () => 50 }).read(sessionId)

  expect(loaded?.relayOutbox[0]?.relayId).toBe('relay-from-before')
  expect(JSON.stringify(loaded?.relayOutbox[0]?.event).length).toBeLessThan(
    CONVEX_EVENT_BUDGET_BYTES,
  )
  // Compacted, not merely trimmed in memory: the bytes on disk are what the
  // outbox's capacity is measured against.
  expect((await stat(outboxPath)).size).toBeLessThan(CONVEX_EVENT_BUDGET_BYTES)
})

test('restart repairs a nested oversized upload and delivers the following terminal without changing recovery state', async () => {
  const sessionId = 'nested-upload-restart'
  const prompt = 'p'.repeat(350 * 1024)
  const checkpoint: AgentTurnState = {
    status: 'running',
    mode: 'agent',
    agent: { status: 'running', messages: [] },
    todos: [{ id: 'full', content: prompt, status: 'in_progress' }],
  }
  const initial = createAgentSessionLedger({ stateDir, now: () => 10 })
  await initial.write({ ...emptyEnvelope(sessionId, 10), checkpoint: { state: checkpoint } })
  const outboxPath = join(dirname(sessionEnvelopePath(stateDir, sessionId)), 'relay-outbox.ndjson')
  await writeFile(
    outboxPath,
    `${JSON.stringify({
      version: 1,
      item: {
        relayId: 'old-nested',
        event: {
          type: 'step',
          step: {
            type: 'tool_call',
            toolName: 'select_state_machine_state',
            toolCallId: 'nested',
            input: { decision: { override: { state: { prompt } } } },
            isError: false,
            output: [{ type: 'text', text: 'selected: ' + 'log '.repeat(25_000) }],
          },
        },
        acceptedThroughSeq: 0,
      },
      commit: { updatedAt: 20 },
    })}\n`,
  )
  const restarted = createAgentSessionLedger({ stateDir, now: () => 30 })
  const delivered: string[] = []
  const send = async (item: GatewaySessionEnvelope['relayOutbox'][number]) => {
    if (item.event.type === 'step' && item.event.step.type === 'tool_call') {
      expect(Buffer.byteLength(JSON.stringify(item.event.step.output))).toBeLessThanOrEqual(1024)
      const part = item.event.step.output?.[0]
      expect(part?.type === 'text' ? part.text : '').toStartWith('selected: ')
      expect(JSON.stringify(item.event.step.output)).toContain('[truncated')
    }
    expect(Buffer.byteLength(JSON.stringify(item.event))).toBeLessThanOrEqual(
      CONVEX_EVENT_BUDGET_BYTES,
    )
    delivered.push(item.event.type)
    return { relayId: item.relayId, seq: delivered.length }
  }
  await restarted.drainRelayOutbox(sessionId, send)
  expect((await restarted.read(sessionId))?.checkpoint?.state).toEqual(checkpoint)
  await restarted.recordRunnerEvent(sessionId, {
    type: 'complete',
    status: 'completed',
    result: 'done',
    state: {
      status: 'completed',
      mode: 'agent',
      agent: { status: 'completed', messages: [] },
    },
  })
  await restarted.drainRelayOutbox(sessionId, send)
  expect(delivered).toEqual(['step', 'complete'])
  expect((await restarted.read(sessionId))?.relayOutbox).toEqual([])
  expect((await restarted.read(sessionId))?.checkpoint?.state.status).toBe('completed')
})

async function removeJournalOrderingMetadata(sessionId: string): Promise<void> {
  const path = sessionEnvelopePath(stateDir, sessionId)
  const snapshot = JSON.parse(await readFile(path, 'utf8'))
  delete snapshot.appliedRelaySequence
  await writeFile(path, JSON.stringify(snapshot))
  const journalPath = join(dirname(path), 'relay-outbox.ndjson')
  const records = (await readFile(journalPath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => {
      const record = JSON.parse(line)
      delete record.sequence
      return JSON.stringify(record)
    })
  await writeFile(journalPath, records.join('\n') + '\n')
}
