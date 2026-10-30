import { describe, expect, it } from 'bun:test'

import { candidateResponseTelemetryProof } from '../src/candidate-response-evidence'
import { ParticipantResourceSlots } from '../src/participant-resource-slots'
import { fixedResponseTriggerDurationSeconds, withTimeout } from '../src/room-probe'
import { WorkerProofTracker } from '../src/worker-proof'

it('binds candidate milestones and caption paint to one worker', () => {
  const events = ['ready', 'stt_final', 'main_result', 'runtime_event']
  const telemetry = events.map((event, sequence) => ({
    payload: JSON.stringify({ event, sequence, captured_at_ns: sequence + 1, metrics_ms: {} }),
    receivedAtMs: 100 + sequence,
    participantIdentity: 'worker-proved',
  }))
  telemetry.splice(3, 0, {
    payload: JSON.stringify({
      event: 'main_result',
      sequence: 99,
      captured_at_ns: 99,
      metrics_ms: {},
    }),
    receivedAtMs: 103,
    participantIdentity: 'other-worker',
  })

  expect(
    candidateResponseTelemetryProof({
      telemetry,
      workerIdentity: 'worker-proved',
      captionRenderedAtMs: 120,
    }),
  ).toEqual({
    telemetry: telemetry.filter(item => item.participantIdentity === 'worker-proved'),
    captionRenderedAtMs: 120,
  })
})

describe('ParticipantResourceSlots', () => {
  it("never resolves a proven worker from another participant's resource", async () => {
    const slots = new ParticipantResourceSlots<string>()
    const workerCapture = slots.wait('worker-fixed')
    let workerSettled = false
    void workerCapture.then(() => {
      workerSettled = true
    })

    slots.resolve('unrelated', 'wrong capture')
    await Promise.resolve()
    expect(workerSettled).toBe(false)

    slots.resolve('worker-fixed', 'worker capture')
    expect(await workerCapture).toBe('worker capture')
  })

  it('forgets the previous room before the same worker identity reconnects', async () => {
    const slots = new ParticipantResourceSlots<string>()
    slots.resolve('worker-fixed', 'first room capture')
    expect(await slots.wait('worker-fixed')).toBe('first room capture')

    slots.clear()
    const next = slots.wait('worker-fixed')
    slots.resolve('worker-fixed', 'second room capture')
    expect(await next).toBe('second room capture')
  })
})

describe('WorkerProofTracker', () => {
  it('accepts only the participant carrying the exact dispatch digest', () => {
    const digest = 'a'.repeat(64)
    const tracker = new WorkerProofTracker(digest)

    expect(
      tracker.observe({
        identity: 'unrelated',
        attributes: { 'probe.metadata_sha256': 'b'.repeat(64) },
      }),
    ).toBeNull()
    expect(
      tracker.observe({
        identity: 'worker-fixed',
        attributes: {
          'probe.metadata_sha256': digest,
          'probe.activation_sha256': 'c'.repeat(64),
        },
      }),
    ).toEqual({
      workerIdentity: 'worker-fixed',
      activationInstanceSha256: 'c'.repeat(64),
    })
    expect(
      tracker.observe({
        identity: 'worker-without-activation-proof',
        attributes: { 'probe.metadata_sha256': digest },
      }),
    ).toBeNull()
  })
})

describe('withTimeout', () => {
  it('rejects a provider wait that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 1, 'remote track timed out')).rejects.toThrow(
      'remote track timed out',
    )
  })
})

describe('fixedResponseTriggerDurationSeconds', () => {
  it("uses only the fixture's first uninterrupted utterance", () => {
    expect(fixedResponseTriggerDurationSeconds(4)).toBe(0.45)
    expect(fixedResponseTriggerDurationSeconds(0.2)).toBe(0.2)
  })
})
