/**
 * Slice 00, canary half — the two questions that need a VM we control.
 *
 *   Q4  Does `cpu_nominal` / `mem_total_bytes` report the widths in
 *       WORKSPACE_VM_CAPS_BY_PLAN on Pro (8c/16G) and Max (10c/24G)? Every live
 *       workspace VM is 4c/8G, so the whole affordability table rests on an
 *       untested assumption.
 *
 *   Q5  Is `cpu_cores` an INSTANTANEOUS sample or an INTERVAL AVERAGE? This
 *       decides slice 02's integration rule and cannot be settled from outside:
 *       - interval average -> a point owns the interval BEHIND it (step)
 *       - instantaneous    -> integrate consecutive pairs (trapezoid)
 *       Picking wrong biases every bill in one direction, permanently.
 *
 *       Method: pin exactly one core on the canary for ~1 provider interval,
 *       then idle. An interval average shows ONE point near 1.0 and its
 *       neighbours near 0. An instantaneous series shows a ramp, or a spike
 *       whose neighbours are partially raised.
 *
 * COSTS REAL VMs. Sequential only — `pool-duet` is 10 wide and shared with
 * production workspaces; two concurrent canaries could starve real users.
 * Every VM is removed in a `finally`.
 *
 * Run: bun run --env-file=.env.local specs/done/vm-compute-fees/research/probe-canary.ts
 */
import { WORKSPACE_VM_POOL, workspaceVmCapsForPlan } from '../../../packages/contract/src/index.ts'
import { ExeClient } from '../../../packages/exe/src/exe.ts'

interface StatPoint {
  timestamp?: string
  cpu_cores?: number
  cpu_nominal?: number
  mem_total_bytes?: number
}

const GIB = 1024 ** 3
const TAG = 'duet-test'
const exe = new ExeClient()
const stamp = Date.now().toString(36)

async function withCanary<T>(
  label: string,
  caps: { cpu: number; memory: string },
  body: (vmName: string, ssh: string) => Promise<T>,
): Promise<T | undefined> {
  const name = `vmfees-canary-${stamp}-${label}`.toLowerCase()
  let created = false
  try {
    const vm = await exe.create({
      name,
      cpu: caps.cpu,
      memory: caps.memory,
      pool: WORKSPACE_VM_POOL,
      tags: [TAG],
      comment: 'vm-compute-fees slice 00 canary',
    })
    created = true
    console.log(`  created ${name} (${caps.cpu}c/${caps.memory})`)
    return await body(vm.vm_name, vm.ssh_dest)
  } catch (error) {
    console.log(`  FAIL ${label}: ${String(error).slice(0, 200)}`)
    return undefined
  } finally {
    if (created) {
      try {
        await exe.remove(name)
        console.log(`  removed ${name}`)
      } catch (error) {
        console.log(`  !! REMOVE FAILED ${name} — ${String(error).slice(0, 160)}`)
        console.log(`  !! clean up by hand: exe rm ${name}`)
      }
    }
  }
}

async function statPoints(vmName: string): Promise<StatPoint[]> {
  const raw = (await exe.stat(vmName, '24h')) as { points?: StatPoint[] }
  return raw.points ?? []
}

// ---- Q4: nameplate ---------------------------------------------------------
console.log('## Q4 — do Pro and Max report their nameplate widths?\n')
for (const plan of ['pro', 'max'] as const) {
  const caps = workspaceVmCapsForPlan(plan)
  await withCanary(plan, caps, async vmName => {
    // The lobby needs a moment before the first metrics point exists.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const points = await statPoints(vmName)
      const point = points.at(-1)
      if (point?.cpu_nominal !== undefined) {
        const memGb = Math.round((point.mem_total_bytes ?? 0) / GIB)
        const expectedMem = Number(caps.memory.replace('GB', ''))
        const ok = point.cpu_nominal === caps.cpu && memGb === expectedMem
        console.log(
          `  ${plan}: reported ${point.cpu_nominal}c/${memGb}G · expected ${caps.cpu}c/${expectedMem}G` +
            ` — ${ok ? 'MATCH' : 'MISMATCH'}`,
        )
        return
      }
      await Bun.sleep(30_000)
    }
    console.log(`  ${plan}: no metrics point appeared within 5 minutes`)
  })
}

// ---- Q5: instantaneous vs interval average --------------------------------
console.log('\n## Q5 — is cpu_cores instantaneous or an interval average?\n')
await withCanary('burn', workspaceVmCapsForPlan('starter'), async (vmName, ssh) => {
  console.log('  waiting 2 min for a quiet baseline...')
  await Bun.sleep(120_000)

  // Exactly one core, for ~11 minutes: longer than the 10-min nominal cadence
  // so at least one interval is fully covered, and bounded by `timeout` so a
  // dropped ssh connection cannot leave a spinner running on a shared pool.
  console.log('  pinning 1 core for 11 min...')
  await exe.exec(ssh, 'nohup timeout 660 sh -c "while :; do :; done" >/dev/null 2>&1 &', 30_000)
  await Bun.sleep(780_000) // burn + one interval of settle

  const points = await statPoints(vmName)
  const tail = points.slice(-10)
  console.log('\n  last 10 points (cores · timestamp):')
  for (const point of tail) {
    console.log(`    ${(point.cpu_cores ?? 0).toFixed(3)}  ${point.timestamp ?? '?'}`)
  }

  const peak = Math.max(...tail.map(point => point.cpu_cores ?? 0))
  const nearPeak = tail.filter(point => (point.cpu_cores ?? 0) > peak * 0.6).length
  console.log(`\n  peak ${peak.toFixed(3)} cores across ${nearPeak} consecutive point(s)`)
  console.log(
    nearPeak <= 2
      ? '  READS AS: interval AVERAGE (a burn of ~1 interval lands on ~1 point).\n' +
          '    -> slice 02 integrates by STEP: each point owns the interval behind it.'
      : '  READS AS: INSTANTANEOUS samples (the burn raises a run of points).\n' +
          '    -> slice 02 integrates consecutive pairs TRAPEZOIDALLY.',
  )
  console.log('  Confirm by eye against the table above before writing slice 02.')
})

console.log('\n## Cleanup check')
const leftovers = (await exe.list()).filter(vm => vm.vm_name.startsWith(`vmfees-canary-${stamp}`))
console.log(
  leftovers.length === 0
    ? '  clean — no canary survived'
    : `  !! ${leftovers.length} LEFTOVER: ${leftovers.map(vm => vm.vm_name).join(', ')}`,
)
