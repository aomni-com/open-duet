export type HeardAudio = {
  durationMs: number
  sampleCount: number
  pcm: Int16Array
}

export const HEARD_SIGNAL_THRESHOLD = 0.001

export function audioFrameToPerformanceMs(
  frame: number,
  sampleRate: number,
  outputTimestamp: { contextTime: number; performanceTime: number },
): number {
  if (!Number.isInteger(frame) || frame < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('audio frame mapping requires a valid frame and sample rate')
  }
  const outputClockOffsetMs = outputTimestamp.performanceTime - outputTimestamp.contextTime * 1_000
  return outputClockOffsetMs + (frame * 1_000) / sampleRate
}

export function scheduledContextTimeToPerformanceMs({
  targetContextTimeSeconds,
  currentContextTimeSeconds,
  currentPerformanceTimeMs,
}: {
  targetContextTimeSeconds: number
  currentContextTimeSeconds: number
  currentPerformanceTimeMs: number
}): number {
  if (
    !Number.isFinite(targetContextTimeSeconds) ||
    !Number.isFinite(currentContextTimeSeconds) ||
    !Number.isFinite(currentPerformanceTimeMs)
  ) {
    throw new Error('scheduled audio timestamp must be finite')
  }
  return currentPerformanceTimeMs + (targetContextTimeSeconds - currentContextTimeSeconds) * 1_000
}

export function performanceMsToContextTime({
  targetPerformanceTimeMs,
  currentContextTimeSeconds,
  currentPerformanceTimeMs,
}: {
  targetPerformanceTimeMs: number
  currentContextTimeSeconds: number
  currentPerformanceTimeMs: number
}): number {
  if (
    !Number.isFinite(targetPerformanceTimeMs) ||
    !Number.isFinite(currentContextTimeSeconds) ||
    !Number.isFinite(currentPerformanceTimeMs)
  ) {
    throw new Error('performance-clock audio timestamp must be finite')
  }
  return currentContextTimeSeconds + (targetPerformanceTimeMs - currentPerformanceTimeMs) / 1_000
}

export function hasConfirmedOutputSilence({
  lastSignalFrame,
  sampleRate,
  outputContextTimeSeconds,
  silenceDurationMs,
}: {
  lastSignalFrame: number
  sampleRate: number
  outputContextTimeSeconds: number
  silenceDurationMs: number
}): boolean {
  if (!Number.isInteger(lastSignalFrame) || lastSignalFrame < 0) {
    throw new Error('last signal frame must be a non-negative integer')
  }
  if (!Number.isFinite(silenceDurationMs) || silenceDurationMs <= 0) {
    throw new Error('silence proof duration must be positive')
  }
  const silenceProofEndSeconds = (lastSignalFrame + 1) / sampleRate + silenceDurationMs / 1_000
  return outputContextTimeSeconds >= silenceProofEndSeconds
}

export function hasOutputClockReachedFrame({
  frame,
  sampleRate,
  outputContextTimeSeconds,
}: {
  frame: number
  sampleRate: number
  outputContextTimeSeconds: number
}): boolean {
  if (!Number.isInteger(frame) || frame < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('output acknowledgement requires a valid frame and sample rate')
  }
  if (!Number.isFinite(outputContextTimeSeconds) || outputContextTimeSeconds < 0) {
    throw new Error('output acknowledgement clock must be non-negative')
  }
  return outputContextTimeSeconds >= (frame + 1) / sampleRate
}

export class HeardAudioLedger {
  readonly #sampleRate: number
  readonly #chunks: { frameStart: number; samples: Float32Array }[] = []
  #sampleCount = 0

  constructor(sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error('sample rate must be a positive integer')
    }
    this.#sampleRate = sampleRate
  }

  capture(frameStart: number, samples: Float32Array): void {
    if (!Number.isInteger(frameStart) || frameStart < 0) {
      throw new Error('audio frame start must be a non-negative integer')
    }
    this.#chunks.push({ frameStart, samples: samples.slice() })
    this.#sampleCount += samples.length
  }

  firstSignalFrameAfter(anchorFrame: number, threshold = HEARD_SIGNAL_THRESHOLD): number | null {
    if (!Number.isInteger(anchorFrame) || anchorFrame < 0) {
      throw new Error('signal anchor must be a non-negative integer')
    }
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new Error('signal threshold must be positive')
    }
    for (const chunk of this.#chunks) {
      const firstOffset = Math.max(0, anchorFrame + 1 - chunk.frameStart)
      for (let offset = firstOffset; offset < chunk.samples.length; offset += 1) {
        if (Math.abs(chunk.samples[offset] ?? 0) >= threshold) {
          return chunk.frameStart + offset
        }
      }
    }
    return null
  }

  hasCapturedPrefix(firstSignalFrame: number, durationMs: number): boolean {
    const requiredSamples = this.#requiredSamples(durationMs)
    const endFrame = firstSignalFrame + requiredSamples
    let capturedThrough = firstSignalFrame
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.frameStart + chunk.samples.length
      if (chunkEnd <= capturedThrough) continue
      if (chunk.frameStart > capturedThrough) return false
      capturedThrough = Math.min(chunkEnd, endFrame)
      if (capturedThrough === endFrame) return true
    }
    return false
  }

  freezePrefix(firstSignalFrame: number, durationMs: number): HeardAudio {
    if (!this.hasCapturedPrefix(firstSignalFrame, durationMs)) {
      throw new Error('heard prefix is not fully captured')
    }
    return this.freezeThroughFrame(
      firstSignalFrame,
      firstSignalFrame + this.#requiredSamples(durationMs),
    )
  }

  hasCapturedThroughFrame(firstSignalFrame: number, endFrame: number): boolean {
    if (!Number.isInteger(endFrame) || endFrame <= firstSignalFrame) return false
    return this.hasCapturedPrefix(
      firstSignalFrame,
      ((endFrame - firstSignalFrame) * 1_000) / this.#sampleRate,
    )
  }

  freezeThroughFrame(firstSignalFrame: number, endFrame: number): HeardAudio {
    if (!this.hasCapturedThroughFrame(firstSignalFrame, endFrame)) {
      throw new Error('heard audio is not fully captured through playout stop')
    }
    const pcm = new Int16Array(endFrame - firstSignalFrame)
    for (const chunk of this.#chunks) {
      const overlapStart = Math.max(chunk.frameStart, firstSignalFrame)
      const overlapEnd = Math.min(chunk.frameStart + chunk.samples.length, endFrame)
      for (let frame = overlapStart; frame < overlapEnd; frame += 1) {
        const sample = Math.max(-1, Math.min(1, chunk.samples[frame - chunk.frameStart] ?? 0))
        pcm[frame - firstSignalFrame] =
          sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767)
      }
    }
    return {
      durationMs: (pcm.length * 1_000) / this.#sampleRate,
      sampleCount: pcm.length,
      pcm,
    }
  }

  #requiredSamples(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('heard-prefix duration must be non-negative')
    }
    return Math.round((durationMs * this.#sampleRate) / 1_000)
  }

  get fullPcmByteLength(): number {
    return this.#sampleCount * Int16Array.BYTES_PER_ELEMENT
  }
}
