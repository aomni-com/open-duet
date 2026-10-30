/**
 * Read-only: the CPU / memory distribution across the live workspace fleet.
 * This is the probe that established real usage sits 0.4-2.6% of a plan grant,
 * which is why the fee charges from the first core-hour with no allowance.
 *
 * Run: bun run --env-file=.env.local specs/done/vm-compute-fees/research/probe-fleet.ts
 */
import { ExeClient, vmUsagePointsFromStat } from '../../../packages/exe/src/index.ts'

const exe = new ExeClient()
const vms = (await exe.list()).filter(vm => (vm.tags ?? []).includes('duet-workspace'))
const rows: string[] = []

for (const vm of vms) {
  try {
    const points = vmUsagePointsFromStat(await exe.stat(vm.vm_name, '24h'))
    if (points.length === 0) {
      rows.push(`${vm.vm_name}  no points`)
      continue
    }
    const cores = points.map(point => point.cpuCores).sort((a, b) => a - b)
    const mem = points.map(point => point.memUsedGb).sort((a, b) => a - b)
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const p95 = (values: number[]) => values[Math.floor(values.length * 0.95)]!

    rows.push(
      `${vm.vm_name.slice(0, 28)}  nom=${points[0]!.cpuNominalCores}c/${points[0]!.memTotalGb.toFixed(0)}G` +
        `  cores avg=${mean(cores).toFixed(3)} p95=${p95(cores).toFixed(3)} max=${cores.at(-1)!.toFixed(2)}` +
        `  memGiB avg=${mean(mem).toFixed(2)} max=${mem.at(-1)!.toFixed(2)}  pts=${points.length}`,
    )
  } catch (error) {
    rows.push(`${vm.vm_name}  STAT FAIL ${String(error).slice(0, 90)}`)
  }
}

console.log(rows.join('\n'))
console.log(`\n${vms.length} workspace VMs. Per-VM averages above are sound;`)
console.log('for fleet totals and the gap distribution, use probe-feasibility.ts.')
