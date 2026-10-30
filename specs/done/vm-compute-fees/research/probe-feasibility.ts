/**
 * Slice 00 — provider feasibility probe. THE KILL GATE.
 *
 * Answers the three questions no amount of reading can settle, and that
 * `probe-fleet.ts` could not: it measured sixteen 4c/8G VMs and told us nothing
 * about Pro/Max nameplates, request rate, or what `cpu_cores` actually means.
 *
 *   Q1  Does the token still work, and does every billable field arrive?
 *       `stat` was HTTP 403 in July and IS 403 again -- the HTTPS token has
 *       never carried `stat` scope. See the slice-00 correction in
 *       `fleet-metering.md`.
 *   Q2  What is the request-rate ceiling, and can a 500-VM sweep finish inside
 *       a daily window?
 *   Q3  What is the real gap distribution between consecutive points? This sets
 *       VM_USAGE_MAX_POINT_GAP_MS in slice 02 — a guessed constant either
 *       clamps normal jitter or fails to clamp a real outage.
 *
 * Read-only over the live fleet. The Pro/Max nameplate check and the
 * instantaneous-vs-average check need canary VMs and live in
 * `probe-canary.ts` so this file can be run freely.
 *
 * Run: bun run --env-file=.env.local specs/done/vm-compute-fees/research/probe-feasibility.ts
 */
import { ExeClient } from '../../../packages/exe/src/exe.ts'

interface StatPoint {
  timestamp?: string
  cpu_cores?: number
  cpu_nominal?: number
  mem_used_bytes?: number
  mem_total_bytes?: number
  fs_used_gb?: number
  fs_total_gb?: number
}

const BILLABLE_FIELDS = ['cpu_cores', 'cpu_nominal', 'mem_used_bytes', 'mem_total_bytes'] as const

/**
 * MUST be constructed the way production is.
 *
 * `new ExeClient()` with no token falls back to SSH, which authenticates as the
 * account owner and can run anything. The deployed backend passes EXE_TOKEN and
 * speaks HTTPS `/exec`, which is scope-limited. An earlier version of this probe
 * omitted the token, took the SSH path, reported `stat` fully working, and this
 * gate was recorded as PASSED -- while the deployed sampler 403s on every VM.
 *
 * The gate is worthless unless it exercises the transport production uses, so
 * this refuses to run on the wrong one rather than quietly passing again.
 */
const exeToken = process.env.EXE_TOKEN
if (exeToken === undefined || exeToken.length === 0) {
  console.error(
    'EXE_TOKEN is required. This probe must speak HTTPS like the deployed backend;\n' +
      "running it over SSH measures the account owner's permissions, not production's.",
  )
  process.exit(1)
}
const exe = new ExeClient({ token: exeToken })
if (exe.transport !== 'https') {
  console.error(`refusing to probe over ${exe.transport}: production speaks https`)
  process.exit(1)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

async function statOnce(
  vmName: string,
): Promise<{ ms: number; points: StatPoint[]; error?: string }> {
  const started = performance.now()
  try {
    const raw = (await exe.stat(vmName, '24h')) as { points?: StatPoint[] }
    return { ms: performance.now() - started, points: raw.points ?? [] }
  } catch (error) {
    return { ms: performance.now() - started, points: [], error: String(error).slice(0, 160) }
  }
}

const vms = (await exe.list()).filter(vm => (vm.tags ?? []).includes('duet-workspace'))
console.log(`# Slice 00 feasibility probe — ${vms.length} workspace VMs\n`)

// ---- Q1: token + field coverage, and Q3: gap distribution -----------------
const latencies: number[] = []
const allGapsMs: number[] = []
const missing = new Map<string, number>()
let totalPoints = 0
let failures = 0

console.log('## Per-VM')
for (const vm of vms) {
  const { ms, points, error } = await statOnce(vm.vm_name)
  latencies.push(ms)
  if (error !== undefined) {
    failures += 1
    console.log(`  ${vm.vm_name.slice(0, 30)}  FAIL ${Math.round(ms)}ms — ${error}`)
    continue
  }
  totalPoints += points.length

  for (const point of points) {
    for (const field of BILLABLE_FIELDS) {
      const value = point[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        missing.set(field, (missing.get(field) ?? 0) + 1)
      }
    }
  }

  const stamps = points
    .map(point => (point.timestamp === undefined ? NaN : Date.parse(point.timestamp)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  for (let index = 1; index < stamps.length; index += 1)
    allGapsMs.push(stamps[index]! - stamps[index - 1]!)

  const nominal = points[0]?.cpu_nominal ?? '?'
  console.log(
    `  ${vm.vm_name.slice(0, 30)}  ok ${String(Math.round(ms)).padStart(4)}ms  ` +
      `${String(points.length).padStart(3)} pts  nominal=${nominal}c`,
  )
}

const sortedLatency = latencies.slice().sort((a, b) => a - b)
const sortedGaps = allGapsMs.slice().sort((a, b) => a - b)

console.log(`\n## Q1 — token and field coverage`)
console.log(`  failures: ${failures}/${vms.length}`)
console.log(`  points seen: ${totalPoints}`)
if (totalPoints === 0) {
  console.log(`  NO POINTS -- field coverage is unknown, not good`)
} else if (missing.size === 0) {
  console.log(`  every billable field present, finite and non-negative on every point`)
} else {
  for (const [field, count] of missing) console.log(`  MISSING/INVALID ${field}: ${count} points`)
}
console.log(
  `  VERDICT: ${failures === 0 && missing.size === 0 && totalPoints > 0 ? 'PASS — provider metering is viable' : 'INVESTIGATE'}`,
)

console.log(`\n## Q2 — latency and projected fleet sweep`)
console.log(
  `  p50 ${Math.round(percentile(sortedLatency, 0.5))}ms   p95 ${Math.round(percentile(sortedLatency, 0.95))}ms`,
)
for (const fleet of [100, 500]) {
  const serialMin = (percentile(sortedLatency, 0.5) * fleet) / 60_000
  console.log(
    `  ${fleet} VMs serial: ~${serialMin.toFixed(1)} min` +
      `  ·  at concurrency 8: ~${(serialMin / 8).toFixed(1)} min`,
  )
}

console.log(`\n## Q3 — gap distribution (sets VM_USAGE_MAX_POINT_GAP_MS)`)
if (sortedGaps.length === 0) {
  console.log('  no consecutive pairs observed')
} else {
  const min = Math.round(sortedGaps[0]! / 1000)
  const p50 = Math.round(percentile(sortedGaps, 0.5) / 1000)
  const p99 = Math.round(percentile(sortedGaps, 0.99) / 1000)
  const max = Math.round(sortedGaps.at(-1)! / 1000)
  console.log(`  n=${sortedGaps.length}  min ${min}s  p50 ${p50}s  p99 ${p99}s  max ${max}s`)
  const suggested = Math.ceil((sortedGaps.at(-1)! * 2) / 60_000) * 60_000
  console.log(`  suggested clamp: ${suggested / 60_000} min (2x observed max, rounded up)`)
}
