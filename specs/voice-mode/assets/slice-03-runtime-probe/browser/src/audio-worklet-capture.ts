import {
  audioFrameToPerformanceMs,
  HEARD_SIGNAL_THRESHOLD,
  HeardAudioLedger,
  hasConfirmedOutputSilence,
  hasOutputClockReachedFrame,
  type HeardAudio,
} from './heard-audio'

const PROCESSOR_NAME = 'duet-heard-audio-capture'
const WORKLET_SOURCE = `
class DuetHeardAudioCapture extends AudioWorkletProcessor {
  firstSignalFrame = null;
  lastSignalFrame = null;

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    output.set(input);
    const copy = input.slice();
    for (let offset = 0; offset < copy.length; offset += 1) {
      if (Math.abs(copy[offset]) < ${HEARD_SIGNAL_THRESHOLD}) continue;
      const signalFrame = currentFrame + offset;
      if (this.firstSignalFrame === null) this.firstSignalFrame = signalFrame;
      this.lastSignalFrame = signalFrame;
    }
    this.port.postMessage(
      {
        kind: "pcm",
        frameStart: currentFrame,
        firstSignalFrame: this.firstSignalFrame,
        lastSignalFrame: this.lastSignalFrame,
        samples: copy,
      },
      [copy.buffer],
    );
    return true;
  }
}
registerProcessor("${PROCESSOR_NAME}", DuetHeardAudioCapture);
`

const workletRegistrations = new WeakMap<AudioContext, Promise<void>>()

export function ensureHeardAudioWorklet(context: AudioContext): Promise<void> {
  const existing = workletRegistrations.get(context)
  if (existing) return existing

  const registration = (async () => {
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }
  })()
  workletRegistrations.set(context, registration)
  void registration.catch(() => {
    if (workletRegistrations.get(context) === registration) {
      workletRegistrations.delete(context)
    }
  })
  return registration
}

type WorkletPcmMessage = {
  kind: 'pcm'
  frameStart: number
  firstSignalFrame: number | null
  lastSignalFrame: number | null
  samples: Float32Array
}

export type HeardCaptureResult = HeardAudio & {
  sampleRate: number
  firstSignalFrame: number
  boundaryFrame: number
  firstSignalPerformanceTimeMs: number
  boundaryPerformanceTimeMs: number
}

export type HeardBoundaryPlan = {
  firstSignalFrame: number
  boundaryFrame: number
  firstSignalPerformanceTimeMs: number
  boundaryPerformanceTimeMs: number
}

export type HeardSilenceAnchor = HeardBoundaryPlan & {
  lastSignalFrame: number
}

export type HeardInterruptionResult = HeardCaptureResult & {
  playoutStoppedFrame: number
  playoutStoppedPerformanceTimeMs: number
  bargeInStartedPerformanceTimeMs: number
  muteLatencyMs: number
  silenceProofMs: number
}

export class BrowserHeardCapture {
  readonly #context: AudioContext
  readonly #source: MediaStreamAudioSourceNode
  readonly #worklet: AudioWorkletNode
  readonly #ledger: HeardAudioLedger
  #firstSignalFrame: number | null = null
  #lastSignalFrame: number | null = null

  private constructor(
    context: AudioContext,
    source: MediaStreamAudioSourceNode,
    worklet: AudioWorkletNode,
  ) {
    this.#context = context
    this.#source = source
    this.#worklet = worklet
    this.#ledger = new HeardAudioLedger(context.sampleRate)
    worklet.port.onmessage = (event: MessageEvent<WorkletPcmMessage>) => {
      if (event.data.kind !== 'pcm') return
      this.#ledger.capture(event.data.frameStart, event.data.samples)
      if (this.#firstSignalFrame === null && event.data.firstSignalFrame !== null) {
        this.#firstSignalFrame = event.data.firstSignalFrame
      }
      if (event.data.lastSignalFrame !== null) {
        this.#lastSignalFrame = event.data.lastSignalFrame
      }
    }
  }

  static async create(
    context: AudioContext,
    mediaStreamTrack: MediaStreamTrack,
  ): Promise<BrowserHeardCapture> {
    await ensureHeardAudioWorklet(context)
    const source = context.createMediaStreamSource(new MediaStream([mediaStreamTrack]))
    const worklet = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    source.connect(worklet).connect(context.destination)
    return new BrowserHeardCapture(context, source, worklet)
  }

  async planOutputBoundary(
    targetDurationMs: number,
    timeoutMs: number,
  ): Promise<HeardBoundaryPlan> {
    const deadlineMs = performance.now() + timeoutMs
    for (;;) {
      this.#validateCaptureState(deadlineMs)
      const firstSignalFrame = this.#firstSignalFrame
      if (firstSignalFrame !== null) {
        const outputTimestamp = this.#outputTimestamp()
        const boundaryFrame =
          firstSignalFrame + Math.round((targetDurationMs * this.#context.sampleRate) / 1_000)
        return {
          firstSignalFrame,
          boundaryFrame,
          firstSignalPerformanceTimeMs: audioFrameToPerformanceMs(
            firstSignalFrame,
            this.#context.sampleRate,
            outputTimestamp,
          ),
          boundaryPerformanceTimeMs: audioFrameToPerformanceMs(
            boundaryFrame,
            this.#context.sampleRate,
            outputTimestamp,
          ),
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
  }

  async waitForFirstOutputThenSilence(
    silenceProofMs: number,
    timeoutMs: number,
  ): Promise<HeardSilenceAnchor> {
    const deadlineMs = performance.now() + timeoutMs
    for (;;) {
      this.#validateCaptureState(deadlineMs)
      const firstSignalFrame = this.#firstSignalFrame
      const lastSignalFrame = this.#lastSignalFrame
      const outputTimestamp = this.#outputTimestamp()
      if (
        firstSignalFrame !== null &&
        lastSignalFrame !== null &&
        hasConfirmedOutputSilence({
          lastSignalFrame,
          sampleRate: this.#context.sampleRate,
          outputContextTimeSeconds: outputTimestamp.contextTime,
          silenceDurationMs: silenceProofMs,
        })
      ) {
        const firstSignalPerformanceTimeMs = audioFrameToPerformanceMs(
          firstSignalFrame,
          this.#context.sampleRate,
          outputTimestamp,
        )
        return {
          firstSignalFrame,
          lastSignalFrame,
          boundaryFrame: lastSignalFrame + 1,
          firstSignalPerformanceTimeMs,
          boundaryPerformanceTimeMs: audioFrameToPerformanceMs(
            lastSignalFrame + 1,
            this.#context.sampleRate,
            outputTimestamp,
          ),
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
  }

  async waitForFirstOutputAfter(
    anchorFrame: number,
    timeoutMs: number,
  ): Promise<HeardBoundaryPlan> {
    const deadlineMs = performance.now() + timeoutMs
    for (;;) {
      this.#validateCaptureState(deadlineMs)
      const firstSignalFrame = this.#ledger.firstSignalFrameAfter(anchorFrame)
      const outputTimestamp = this.#outputTimestamp()
      if (
        firstSignalFrame !== null &&
        hasOutputClockReachedFrame({
          frame: firstSignalFrame,
          sampleRate: this.#context.sampleRate,
          outputContextTimeSeconds: outputTimestamp.contextTime,
        })
      ) {
        const firstSignalPerformanceTimeMs = audioFrameToPerformanceMs(
          firstSignalFrame,
          this.#context.sampleRate,
          outputTimestamp,
        )
        return {
          firstSignalFrame,
          boundaryFrame: firstSignalFrame,
          firstSignalPerformanceTimeMs,
          boundaryPerformanceTimeMs: firstSignalPerformanceTimeMs,
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
  }

  async waitForInterruptedOutput({
    boundaryDurationMs,
    bargeInStartedPerformanceTimeMs,
    silenceProofMs,
    timeoutMs,
  }: {
    boundaryDurationMs: number
    bargeInStartedPerformanceTimeMs: number
    silenceProofMs: number
    timeoutMs: number
  }): Promise<HeardInterruptionResult> {
    const deadlineMs = performance.now() + timeoutMs
    for (;;) {
      this.#validateCaptureState(deadlineMs)
      const firstSignalFrame = this.#firstSignalFrame
      const lastSignalFrame = this.#lastSignalFrame
      const outputTimestamp = this.#outputTimestamp()
      if (
        firstSignalFrame !== null &&
        lastSignalFrame !== null &&
        hasConfirmedOutputSilence({
          lastSignalFrame,
          sampleRate: this.#context.sampleRate,
          outputContextTimeSeconds: outputTimestamp.contextTime,
          silenceDurationMs: silenceProofMs,
        }) &&
        lastSignalFrame + 1 >=
          firstSignalFrame + Math.round((boundaryDurationMs * this.#context.sampleRate) / 1_000) &&
        this.#ledger.hasCapturedThroughFrame(firstSignalFrame, lastSignalFrame + 1)
      ) {
        const heard = this.#ledger.freezeThroughFrame(firstSignalFrame, lastSignalFrame + 1)
        const boundaryFrame =
          firstSignalFrame + Math.round((boundaryDurationMs * this.#context.sampleRate) / 1_000)
        const playoutStoppedFrame = lastSignalFrame + 1
        const playoutStoppedPerformanceTimeMs = audioFrameToPerformanceMs(
          playoutStoppedFrame,
          this.#context.sampleRate,
          outputTimestamp,
        )
        const muteLatencyMs = playoutStoppedPerformanceTimeMs - bargeInStartedPerformanceTimeMs
        if (muteLatencyMs < 0) {
          throw new Error('remote response stopped before browser barge-in')
        }
        return {
          ...heard,
          sampleRate: this.#context.sampleRate,
          firstSignalFrame,
          boundaryFrame,
          firstSignalPerformanceTimeMs: audioFrameToPerformanceMs(
            firstSignalFrame,
            this.#context.sampleRate,
            outputTimestamp,
          ),
          boundaryPerformanceTimeMs: audioFrameToPerformanceMs(
            boundaryFrame,
            this.#context.sampleRate,
            outputTimestamp,
          ),
          playoutStoppedFrame,
          playoutStoppedPerformanceTimeMs,
          bargeInStartedPerformanceTimeMs,
          muteLatencyMs,
          silenceProofMs,
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
  }

  #validateCaptureState(deadlineMs: number): void {
    if (performance.now() >= deadlineMs) {
      throw new Error('audible remote-track output timed out')
    }
    if (this.#context.state !== 'running') {
      throw new Error('audio context suspended during remote-output capture')
    }
    if (document.visibilityState !== 'visible') {
      throw new Error('document hidden during remote-output capture')
    }
  }

  #outputTimestamp(): { contextTime: number; performanceTime: number } {
    if (typeof this.#context.getOutputTimestamp !== 'function') {
      throw new Error('AudioContext.getOutputTimestamp is unavailable')
    }
    const timestamp = this.#context.getOutputTimestamp()
    if (
      typeof timestamp.contextTime !== 'number' ||
      typeof timestamp.performanceTime !== 'number'
    ) {
      throw new Error('AudioContext output timestamp is incomplete')
    }
    return {
      contextTime: timestamp.contextTime,
      performanceTime: timestamp.performanceTime,
    }
  }

  disconnect(): void {
    this.#worklet.port.onmessage = null
    this.#source.disconnect()
    this.#worklet.disconnect()
  }
}
