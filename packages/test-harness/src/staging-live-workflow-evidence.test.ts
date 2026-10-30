import { expect, test, spyOn } from 'bun:test'

import {
  findWorkflowGeneration,
  inspectWorkflowHistory,
  waitForWorkflowRuntime,
  assertWorkflowRoutingOff,
  historyHasTerminalAfter,
} from './staging-live-workflow-evidence.ts'
import { runtimeManifestFixture } from './test-fixtures/runtime-manifest'

test('advisor-free verdict rejects advisor execution even when the final result is complete', () => {
  expect(() =>
    inspectWorkflowHistory(
      [
        {
          seq: 1,
          event: {
            type: 'step',
            step: { type: 'tool_call', toolName: 'ask_advisor', input: {}, output: [] },
          },
        },
      ],
      200,
    ),
  ).toThrow('advisor')
})

test('reads actual managed tiers and refuses any enabled tier, including future tiers', () => {
  const routing = {
    defaultTier: 'frontier',
    tiers: { frontier: { advisor: { enabled: false } }, future: { advisor: { enabled: true } } },
  }
  expect(() => assertWorkflowRoutingOff(routing)).toThrow('future advisor enabled')
  routing.tiers.future.advisor.enabled = false
  expect(() => assertWorkflowRoutingOff(routing)).not.toThrow()
})

test('an old terminal cannot satisfy a newly accepted continuation', () => {
  const rows = [
    { seq: 1, event: { type: 'complete' } },
    { seq: 2, event: { type: 'prompt_submitted', prompt: 'Continue' } },
  ]
  expect(historyHasTerminalAfter(rows, 'Continue')).toBe(false)
  rows.push({ seq: 3, event: { type: 'complete' } })
  expect(historyHasTerminalAfter(rows, 'Continue')).toBe(true)
})

test('counts admitted retries after a diagnostic once across repeated machine snapshots', () => {
  const execution = {
    id: 'attempt-4',
    fingerprint: 'same',
    unchangedFrom: { id: 'attempt-3', outcome: 'failed' },
  }
  const started = { type: 'state_started', execution }
  const rows = [
    {
      seq: 1,
      event: {
        type: 'system',
        message:
          '<system-reminder>\nUNCHANGED EXECUTION: the last 3 retained settled attempts\n</system-reminder>',
      },
    },
    { seq: 2, event: { type: 'state_machine', stateMachine: { history: [started] } } },
    { seq: 3, event: { type: 'state_machine', stateMachine: { history: [started] } } },
  ]
  expect(inspectWorkflowHistory(rows, 200).unchangedRetriesAfterDiagnostic).toBe(1)
})

test('budget includes an in-flight tool in addition to completed calls', () => {
  const rows = [
    {
      seq: 1,
      event: { type: 'step', step: { type: 'tool_call', toolCallId: 'a', toolName: 'bash' } },
    },
    {
      seq: 2,
      event: { type: 'step', step: { type: 'tool_call_start', toolCallId: 'b', toolName: 'bash' } },
    },
  ]
  expect(() => inspectWorkflowHistory(rows, 1)).toThrow('exceeded 1 tool calls: 2')
})

test('runtime readiness waits for the complete announced inventory identity', async () => {
  const announced = runtimeManifestFixture('current')
  const stale = runtimeManifestFixture('stale')
  const observations = [
    { runtimeVersion: stale.version },
    {},
    { runtimeVersion: announced.version },
  ]
  const result = await waitForWorkflowRuntime({
    loadAnnouncement: async () => announced,
    load: async () => observations.shift()!,
  })
  expect(result).toEqual({ announced, health: { runtimeVersion: announced.version } })
})

test('a wrong inventory hash is rejected before any health polling', async () => {
  const announced = runtimeManifestFixture('bad')
  announced.artifacts[0]!.sha256 = '0'.repeat(64)
  await expect(
    waitForWorkflowRuntime({
      loadAnnouncement: async () => announced,
      load: async () => {
        throw new Error('health must not be queried')
      },
    }),
  ).rejects.toThrow('runtime manifest identity')
})

test('workflow model proof requires settled output on the selected tier and an advertised model', () => {
  const generation = {
    _id: 'generation',
    tier: 'balanced',
    model: 'fixture/expected',
    status: 'settled',
    upstreamMetadata: { usage: { outputTokens: 12 } },
  }
  expect(findWorkflowGeneration([generation], ['fixture/other', 'fixture/expected'])).toEqual(
    generation,
  )
  for (const changed of [
    { model: 'fixture/old' },
    { tier: 'frontier' },
    { status: 'forwarding' },
    { upstreamMetadata: { usage: { outputTokens: 0 } } },
  ]) {
    expect(
      findWorkflowGeneration(
        [{ ...generation, ...changed }],
        ['fixture/other', 'fixture/expected'],
      ),
    ).toBeUndefined()
  }
  expect(findWorkflowGeneration([], ['fixture/other', 'fixture/expected'])).toBeUndefined()
})

test('runtime readiness allows the normal npm rollout window and bounds stalled activation', async () => {
  let elapsed = 0
  const now = spyOn(Date, 'now').mockImplementation(() => elapsed)
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async milliseconds => {
    elapsed += Number(milliseconds)
  })
  const announced = runtimeManifestFixture('ready')
  const ready = { runtimeVersion: announced.version }
  const stale = { runtimeVersion: runtimeManifestFixture('stale').version }
  try {
    expect(
      await waitForWorkflowRuntime({
        loadAnnouncement: async () => announced,
        load: async () => (elapsed >= 30 * 60_000 ? ready : stale),
      }),
    ).toEqual({ announced, health: ready })
    elapsed = 0
    await expect(
      waitForWorkflowRuntime({ loadAnnouncement: async () => announced, load: async () => stale }),
    ).rejects.toThrow('workflow runtime release convergence')
    expect(Number.isFinite(elapsed)).toBe(true)
    expect(elapsed).toBeGreaterThan(0)
  } finally {
    sleep.mockRestore()
    now.mockRestore()
  }
})

test('runtime readiness follows a replacement complete inventory announcement', async () => {
  let elapsed = 0
  const now = spyOn(Date, 'now').mockImplementation(() => elapsed)
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async milliseconds => {
    elapsed += Number(milliseconds)
  })
  const original = runtimeManifestFixture('original')
  const replacement = runtimeManifestFixture('replacement')
  try {
    expect(
      await waitForWorkflowRuntime({
        loadAnnouncement: async () => (elapsed === 0 ? original : replacement),
        load: async () => ({ runtimeVersion: replacement.version }),
      }),
    ).toEqual({ announced: replacement, health: { runtimeVersion: replacement.version } })
  } finally {
    sleep.mockRestore()
    now.mockRestore()
  }
})
