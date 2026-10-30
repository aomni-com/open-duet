/**
 * Where a request spent its time, phase by phase, as a `Server-Timing` header.
 *
 * A session input's wait is split across owners — the API's own Convex round
 * trips, the integration provider, the gateway's spawn — and a total says
 * nothing about which one to fix. The browser's devtools render this header
 * natively, so the split is readable on any deployment without a log dive.
 */
export interface PhaseTimer {
  /** Closes the phase that began at the previous mark (or at creation). */
  mark(name: string): void
  header(): string
}

export function createPhaseTimer(now: () => number = Date.now): PhaseTimer {
  const phases: Array<{ name: string; durationMs: number }> = []
  let last = now()
  return {
    mark(name) {
      const at = now()
      phases.push({ name, durationMs: Math.max(0, Math.round(at - last)) })
      last = at
    },
    header() {
      return phases.map(phase => `${phase.name};dur=${phase.durationMs}`).join(', ')
    },
  }
}
