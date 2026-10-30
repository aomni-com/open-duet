import type { HeardInterruptionResult } from './audio-worklet-capture'

export type BrowserInterruptionResult = Omit<HeardInterruptionResult, 'pcm'> & {
  heardPcmBase64: string
  audioContextState: AudioContextState
  outputTimestampSupported: boolean
}

export function serializeInterruptionCapture(
  result: HeardInterruptionResult,
  audioContextState: AudioContextState,
  outputTimestampSupported: boolean,
): BrowserInterruptionResult {
  const { pcm, ...metadata } = result
  return {
    ...metadata,
    heardPcmBase64: int16ToBase64(pcm),
    audioContextState,
    outputTimestampSupported,
  }
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
