export type ReceivedTelemetry = {
  payload: string
  receivedAtMs: number
  participantIdentity: string
}

export type CandidateResponseTelemetryProof = {
  telemetry: ReceivedTelemetry[]
  captionRenderedAtMs: number
}

const REQUIRED_EVENTS = new Set(['ready', 'stt_final', 'main_result', 'runtime_event'])

export function candidateResponseTelemetryProof({
  telemetry,
  workerIdentity,
  captionRenderedAtMs,
}: {
  telemetry: ReceivedTelemetry[]
  workerIdentity: string
  captionRenderedAtMs: number | null
}): CandidateResponseTelemetryProof | null {
  if (captionRenderedAtMs === null || !Number.isFinite(captionRenderedAtMs)) return null
  const bound = telemetry.filter(item => item.participantIdentity === workerIdentity)
  const observed = new Set<string>()
  for (const item of bound) {
    try {
      const packet: unknown = JSON.parse(item.payload)
      if (
        typeof packet === 'object' &&
        packet !== null &&
        'event' in packet &&
        typeof packet.event === 'string'
      ) {
        observed.add(packet.event)
      }
    } catch {
      return null
    }
  }
  if ([...REQUIRED_EVENTS].some(event => !observed.has(event))) return null
  return { telemetry: bound, captionRenderedAtMs }
}
