/**
 * The provider's metrics payload, and the only place its wire vocabulary lives.
 *
 * `snake_case` stops here. Everything downstream — the sampler, the pricing
 * kernel, the ledger — sees `VmUsagePoint` and never learns that exe.dev calls
 * a core count `cpu_cores`.
 *
 * `VmUsagePoint` itself belongs to `@repo/contract` beside the pricing kernel
 * that consumes it; it is re-exported here so this parser can name its return
 * type without callers needing two imports.
 */
import type { VmUsagePoint } from '@repo/contract'

export type { VmUsagePoint }

/** Provider wire shape. Every field optional: the provider is not our type system. */
export interface ExeStatPoint {
  timestamp?: string
  cpu_cores?: number
  cpu_nominal?: number
  mem_used_bytes?: number
  mem_total_bytes?: number
  fs_used_gb?: number
  fs_total_gb?: number
}

export interface ExeStatResponse {
  vm_name?: string
  points?: ExeStatPoint[]
}

const BYTES_PER_GIB = 1024 ** 3

function usableNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Wire -> domain.
 *
 * A malformed *envelope* throws: that is the provider breaking its contract, and
 * silently returning zero points would read to every caller as "this VM was
 * idle" — the one wrong answer that looks exactly like a right one.
 *
 * A malformed *point* is dropped: one bad reading must not cost a workspace its
 * whole day. Callers that care about the drop rate compare `points.length`
 * against the raw count.
 *
 * `disk_used_gb` is deliberately absent from `ExeStatPoint`. It fluctuated
 * 0.1326 -> 0.1254 -> 0.1269 across consecutive points while `fs_used_gb` held
 * flat, and it contradicts the account-level figure the pool reports. Its
 * absence from the interface is the enforcement.
 */
export function vmUsagePointsFromStat(raw: unknown): VmUsagePoint[] {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`exe stat returned ${raw === null ? 'null' : typeof raw}, expected an object`)
  }
  const { points } = raw as ExeStatResponse
  if (points === undefined) throw new Error('exe stat response has no `points`')
  if (!Array.isArray(points)) throw new Error('exe stat `points` is not an array')

  const usable: VmUsagePoint[] = []
  for (const point of points) {
    if (point === null || typeof point !== 'object') continue
    const at = point.timestamp === undefined ? NaN : Date.parse(point.timestamp)
    if (!Number.isFinite(at)) continue

    // The four billable fields are required. `fs_*` only feeds the chart and the
    // storage bar, so a point missing them is still worth money.
    const cpuCores = usableNumber(point.cpu_cores)
    const cpuNominalCores = usableNumber(point.cpu_nominal)
    const memUsedBytes = usableNumber(point.mem_used_bytes)
    const memTotalBytes = usableNumber(point.mem_total_bytes)
    if (
      cpuCores === undefined ||
      cpuNominalCores === undefined ||
      memUsedBytes === undefined ||
      memTotalBytes === undefined
    ) {
      continue
    }

    const fsUsedGb = usableNumber(point.fs_used_gb)
    const fsTotalGb = usableNumber(point.fs_total_gb)
    usable.push({
      at,
      cpuCores,
      cpuNominalCores,
      memUsedGb: memUsedBytes / BYTES_PER_GIB,
      memTotalGb: memTotalBytes / BYTES_PER_GIB,
      ...(fsUsedGb === undefined ? {} : { fsUsedGb }),
      ...(fsTotalGb === undefined ? {} : { fsTotalGb }),
    })
  }
  return usable
}
