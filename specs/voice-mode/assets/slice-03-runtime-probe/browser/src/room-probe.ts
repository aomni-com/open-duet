import {
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type LocalParticipant,
  type RemoteParticipant,
} from 'livekit-client'

import { BrowserHeardCapture } from './audio-worklet-capture'
import {
  candidateResponseTelemetryProof,
  type CandidateResponseTelemetryProof,
  type ReceivedTelemetry,
} from './candidate-response-evidence'
import { performanceMsToContextTime, scheduledContextTimeToPerformanceMs } from './heard-audio'
import { ParticipantResourceSlots } from './participant-resource-slots'
import { serializeInterruptionCapture, type BrowserInterruptionResult } from './probe-result'
import { WorkerProofTracker, type WorkerProof } from './worker-proof'

type ConnectOptions = {
  livekitUrl: string
  participantToken: string
  fixtureUrl: string
}

type ClockSample = {
  browserSendMs: number
  workerReceiveNs: number
  workerSendNs: number
  browserReceiveMs: number
}

const TELEMETRY_TOPIC = 'duet.voice.slice03.telemetry'
const FIXED_RESPONSE_TRIGGER_SECONDS = 0.45

export function fixedResponseTriggerDurationSeconds(bufferDurationSeconds: number): number {
  if (!Number.isFinite(bufferDurationSeconds) || bufferDurationSeconds <= 0) {
    throw new Error('input fixture duration must be positive')
  }
  return Math.min(bufferDurationSeconds, FIXED_RESPONSE_TRIGGER_SECONDS)
}

export class BrowserRoomProbe {
  readonly #room = new Room({ adaptiveStream: false, dynacast: false })
  readonly #context = new AudioContext({ latencyHint: 'interactive' })
  #inputDestination: MediaStreamAudioDestinationNode | null = null
  #inputBuffer: AudioBuffer | null = null
  #inputPublication: LocalTrackPublication | null = null
  readonly #captures = new ParticipantResourceSlots<BrowserHeardCapture>()
  readonly #captureParticipants = new Set<string>()
  readonly #activeCaptures = new Set<BrowserHeardCapture>()
  readonly #telemetry: ReceivedTelemetry[] = []
  readonly #captionRenderedAtMs = new Map<string, number>()
  readonly #provenWorkers = new Set<string>()
  readonly #caption: HTMLOutputElement

  constructor(caption: HTMLOutputElement) {
    this.#caption = caption
    this.#room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== Track.Kind.Audio || !(track instanceof RemoteAudioTrack)) return
      if (this.#captureParticipants.has(participant.identity)) return
      this.#captureParticipants.add(participant.identity)
      void BrowserHeardCapture.create(this.#context, track.mediaStreamTrack).then(
        capture => {
          this.#activeCaptures.add(capture)
          this.#captures.resolve(participant.identity, capture)
        },
        error => {
          this.#captures.reject(
            participant.identity,
            error instanceof Error ? error : new Error(String(error)),
          )
        },
      )
    })
    this.#room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== TELEMETRY_TOPIC || !participant) return
      const decoded = new TextDecoder().decode(payload)
      this.#telemetry.push({
        payload: decoded,
        receivedAtMs: performance.now(),
        participantIdentity: participant.identity,
      })
      if (this.#provenWorkers.has(participant.identity) && isRuntimeEvent(decoded)) {
        this.#caption.textContent = 'Main result ready'
        this.#caption.dataset.state = 'ready'
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const bounds = this.#caption.getBoundingClientRect()
            if (document.visibilityState === 'visible' && bounds.width > 0 && bounds.height > 0) {
              this.#captionRenderedAtMs.set(participant.identity, performance.now())
            }
          })
        })
      }
    })
  }

  async armAudio(): Promise<void> {
    await this.#context.resume()
    if (this.#context.state !== 'running') {
      throw new Error('audio context did not enter the running state')
    }
  }

  async connect(options: ConnectOptions): Promise<void> {
    await this.armAudio()
    const response = await fetch(options.fixtureUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`)
    this.#inputBuffer = await this.#context.decodeAudioData(await response.arrayBuffer())
    this.#inputDestination = this.#context.createMediaStreamDestination()
    await this.#room.connect(options.livekitUrl, options.participantToken, {
      autoSubscribe: true,
    })
    const track = this.#inputDestination.stream.getAudioTracks()[0]
    if (!track) throw new Error('synthetic microphone track was not created')
    this.#inputPublication = await this.#room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
      dtx: false,
      red: false,
      name: 'slice03-synthetic-microphone',
    })
  }

  startInputFixture(): { startedAtMs: number; endsAtMs: number } {
    if (!this.#inputBuffer) throw new Error('probe is not connected')
    return this.#startInputAtPerformanceTime(
      performance.now() + 50,
      fixedResponseTriggerDurationSeconds(this.#inputBuffer.duration),
    )
  }

  #startInputAtPerformanceTime(
    targetPerformanceTimeMs: number,
    durationSeconds: number,
  ): { startedAtMs: number; endsAtMs: number } {
    if (!this.#inputBuffer || !this.#inputDestination) throw new Error('probe is not connected')
    const source = this.#context.createBufferSource()
    source.buffer = this.#inputBuffer
    source.connect(this.#inputDestination)
    const currentContextTime = this.#context.currentTime
    const currentPerformanceTimeMs = performance.now()
    if (targetPerformanceTimeMs - currentPerformanceTimeMs < 20) {
      throw new Error('output boundary left insufficient microphone scheduling lead')
    }
    const startAt = performanceMsToContextTime({
      targetPerformanceTimeMs,
      currentContextTimeSeconds: currentContextTime,
      currentPerformanceTimeMs,
    })
    source.start(startAt)
    source.stop(startAt + durationSeconds)
    const startedAtMs = scheduledContextTimeToPerformanceMs({
      targetContextTimeSeconds: startAt,
      currentContextTimeSeconds: currentContextTime,
      currentPerformanceTimeMs,
    })
    return {
      startedAtMs,
      endsAtMs: startedAtMs + durationSeconds * 1_000,
    }
  }

  async waitForWorkerMetadata(expectedDigest: string, timeoutMs = 30_000): Promise<WorkerProof> {
    const tracker = new WorkerProofTracker(expectedDigest)
    let resolveProof!: (proof: WorkerProof) => void
    const proof = new Promise<WorkerProof>(resolve => {
      resolveProof = resolve
    })
    const observe = (participant: RemoteParticipant): void => {
      const match = tracker.observe(participant)
      if (match) resolveProof(match)
    }
    const participantConnected = (participant: RemoteParticipant): void => observe(participant)
    const participantAttributesChanged = (
      _changed: Record<string, string>,
      participant: RemoteParticipant | LocalParticipant,
    ): void => {
      const remoteParticipant = this.#room.remoteParticipants.get(participant.identity)
      if (remoteParticipant === participant) observe(remoteParticipant)
    }

    this.#room.on(RoomEvent.ParticipantConnected, participantConnected)
    this.#room.on(RoomEvent.ParticipantAttributesChanged, participantAttributesChanged)
    for (const participant of this.#room.remoteParticipants.values()) observe(participant)
    try {
      const proven = await withTimeout(proof, timeoutMs, 'worker metadata proof timed out')
      this.#provenWorkers.add(proven.workerIdentity)
      return proven
    } finally {
      this.#room.off(RoomEvent.ParticipantConnected, participantConnected)
      this.#room.off(RoomEvent.ParticipantAttributesChanged, participantAttributesChanged)
    }
  }

  async collectClockSamples(
    workerIdentity: string,
    sampleId: string,
    count = 5,
  ): Promise<ClockSample[]> {
    if (!Number.isInteger(count) || count < 3 || count > 10) {
      throw new Error('clock sample count must be between three and ten')
    }
    const samples: ClockSample[] = []
    for (let index = 0; index < count; index += 1) {
      const browserSendMs = performance.now()
      const responseText = await this.#room.localParticipant.performRpc({
        destinationIdentity: workerIdentity,
        method: 'probe.clock',
        payload: JSON.stringify({ sample_id: sampleId, browser_send_ms: browserSendMs }),
        responseTimeout: 8_000,
      })
      const browserReceiveMs = performance.now()
      const response: unknown = JSON.parse(responseText)
      if (
        typeof response !== 'object' ||
        response === null ||
        !('sample_id' in response) ||
        response.sample_id !== sampleId ||
        !('worker_receive_ns' in response) ||
        typeof response.worker_receive_ns !== 'number' ||
        !('worker_send_ns' in response) ||
        typeof response.worker_send_ns !== 'number'
      ) {
        throw new Error('worker clock response does not match the probe contract')
      }
      samples.push({
        browserSendMs,
        workerReceiveNs: response.worker_receive_ns,
        workerSendNs: response.worker_send_ns,
        browserReceiveMs,
      })
    }
    return samples
  }

  async interruptAtHeardBoundary(
    workerIdentity: string,
    timeoutMs = 45_000,
  ): Promise<BrowserInterruptionResult> {
    const startedAtMs = performance.now()
    const capture = await withTimeout(
      this.#captures.wait(workerIdentity),
      timeoutMs,
      'remote audio track timed out',
    )
    let remainingMs = timeoutMs - (performance.now() - startedAtMs)
    if (remainingMs <= 0) throw new Error('audible remote-track interruption timed out')
    const boundary = await capture.planOutputBoundary(1_200, remainingMs)
    const bargeIn = this.#startInputAtPerformanceTime(
      boundary.boundaryPerformanceTimeMs,
      fixedResponseTriggerDurationSeconds(this.#inputBuffer?.duration ?? 0),
    )
    remainingMs = timeoutMs - (performance.now() - startedAtMs)
    if (remainingMs <= 0) throw new Error('audible remote-track interruption timed out')
    const result = await capture.waitForInterruptedOutput({
      boundaryDurationMs: 1_200,
      bargeInStartedPerformanceTimeMs: bargeIn.startedAtMs,
      silenceProofMs: 250,
      timeoutMs: remainingMs,
    })
    return serializeInterruptionCapture(
      result,
      this.#context.state,
      typeof this.#context.getOutputTimestamp === 'function',
    )
  }

  async waitForCandidateResponse(
    workerIdentity: string,
    sampleId: string,
    timeoutMs = 45_000,
  ): Promise<{
    acknowledgementFirstSignalPerformanceTimeMs: number
    mainResponseFirstSignalPerformanceTimeMs: number
    audioContextState: AudioContextState
    outputTimestampSupported: boolean
    telemetry: ReceivedTelemetry[]
    captionRenderedAtMs: number
  }> {
    const startedAtMs = performance.now()
    const capture = await withTimeout(
      this.#captures.wait(workerIdentity),
      timeoutMs,
      'remote audio track timed out',
    )
    const remainingMs = timeoutMs - (performance.now() - startedAtMs)
    if (remainingMs <= 0) throw new Error('audible remote-track response timed out')
    const acknowledgement = await capture.waitForFirstOutputThenSilence(250, remainingMs)
    const responseText = await this.#room.localParticipant.performRpc({
      destinationIdentity: workerIdentity,
      method: 'probe.main_result',
      payload: JSON.stringify({ sample_id: sampleId }),
      responseTimeout: 8_000,
    })
    const response: unknown = JSON.parse(responseText)
    if (
      typeof response !== 'object' ||
      response === null ||
      !('accepted' in response) ||
      response.accepted !== true ||
      !('sample_id' in response) ||
      response.sample_id !== sampleId
    ) {
      throw new Error('Main result RPC response does not match the probe contract')
    }
    const afterRpcMs = timeoutMs - (performance.now() - startedAtMs)
    if (afterRpcMs <= 0) throw new Error('audible Main response timed out')
    const [mainResponse, telemetryProof] = await Promise.all([
      capture.waitForFirstOutputAfter(acknowledgement.lastSignalFrame, afterRpcMs),
      this.#waitForCandidateTelemetry(workerIdentity, afterRpcMs),
    ])
    return {
      acknowledgementFirstSignalPerformanceTimeMs: acknowledgement.firstSignalPerformanceTimeMs,
      mainResponseFirstSignalPerformanceTimeMs: mainResponse.firstSignalPerformanceTimeMs,
      audioContextState: this.#context.state,
      outputTimestampSupported: typeof this.#context.getOutputTimestamp === 'function',
      ...telemetryProof,
    }
  }

  async #waitForCandidateTelemetry(
    workerIdentity: string,
    timeoutMs: number,
  ): Promise<CandidateResponseTelemetryProof> {
    const deadlineMs = performance.now() + timeoutMs
    while (performance.now() < deadlineMs) {
      const proof = candidateResponseTelemetryProof({
        telemetry: this.#telemetry,
        workerIdentity,
        captionRenderedAtMs: this.#captionRenderedAtMs.get(workerIdentity) ?? null,
      })
      if (proof) return proof
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('candidate response telemetry timed out')
  }

  async disconnect(): Promise<void> {
    for (const capture of this.#activeCaptures) capture.disconnect()
    this.#activeCaptures.clear()
    this.#captureParticipants.clear()
    this.#captures.clear()
    if (this.#inputPublication?.track) {
      await this.#room.localParticipant.unpublishTrack(this.#inputPublication.track)
    }
    await this.#room.disconnect()
    this.#inputPublication = null
    this.#inputDestination = null
    this.#inputBuffer = null
    this.#telemetry.length = 0
    this.#captionRenderedAtMs.clear()
    this.#provenWorkers.clear()
  }
}

function isRuntimeEvent(payload: string): boolean {
  try {
    const packet: unknown = JSON.parse(payload)
    return (
      typeof packet === 'object' &&
      packet !== null &&
      'event' in packet &&
      packet.event === 'runtime_event'
    )
  } catch {
    return false
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('probe timeout must be positive')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
