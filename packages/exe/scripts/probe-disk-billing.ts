/**
 * Probe: does exe.dev charge for *provisioned* disk or *consumed* disk?
 *
 * This decides the shape of per-tier storage. If the pool is charged on
 * provisioned capacity, handing a Max subscriber a 100GB disk costs 100GB
 * whether or not they fill it, and a downgrade must physically reclaim space.
 * If it is charged on consumed bytes, the disk size is a *ceiling* we can hand
 * out freely and a downgrade becomes a policy question, not an infra one.
 *
 * Method — a fleet cross-check, not a delta. `billing usage` is sampled, not
 * instantaneous (creating a VM does not move `disk_used_bytes` within the
 * minute), so a before/after delta proves nothing. What does prove it: sum the
 * `disk_capacity_bytes` the lobby reports for every VM and compare that total
 * against the pool's `disk_used_bytes`. Capacity far above reported usage, with
 * zero overage, means only consumed blocks are counted.
 *
 * Run: bun run --env-file=../../.env.local scripts/probe-disk-billing.ts
 */

import { authenticate, fenced, makeContext, writeReport } from './probe-common.ts'

interface Usage {
  disk_used_bytes: number
  included_disk_bytes: number
  disk_overage_bytes: number
  vm_count: number
}

const GB = 1024 ** 3

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB`
}

/** `billing` is not covered by the probe token's `cmds`; read it over SSH. */
async function sshLobby(command: string[]): Promise<string> {
  const proc = Bun.spawn(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'exe.dev', ...command, '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`ssh exe.dev ${command.join(' ')} failed (exit ${code}): ${err}`)
  return out
}

async function main(): Promise<void> {
  const ctx = makeContext()
  await authenticate(ctx)

  const usage = JSON.parse(await sshLobby(['billing', 'usage'])) as Usage
  const plan = JSON.parse(await sshLobby(['billing', 'plan'])) as Record<string, unknown>
  const vms = await ctx.control.list()

  const provisioned = vms.reduce((sum, vm) => sum + (vm.disk_capacity_bytes ?? 0), 0)
  const ratio = usage.disk_used_bytes / provisioned

  const notes = [
    `${vms.length} VMs, total provisioned capacity: ${gb(provisioned)}`,
    `pool reports disk_used_bytes: ${gb(usage.disk_used_bytes)} of ${gb(usage.included_disk_bytes)} included`,
    `disk_overage_bytes: ${gb(usage.disk_overage_bytes)}`,
    `reported usage is ${(ratio * 100).toFixed(0)}% of provisioned capacity`,
    ratio > 0.95
      ? 'VERDICT: provision-billed — reported usage tracks provisioned capacity.'
      : 'VERDICT: consumption-billed — provisioned capacity is a ceiling, only written blocks are charged.',
  ]

  const perVm = vms
    .map(vm => `${vm.vm_name.padEnd(40)} ${gb(vm.disk_capacity_bytes ?? 0).padStart(10)}`)
    .join('\n')

  const report = [
    '# Probe: exe.dev disk billing (provisioned vs consumed)',
    '',
    ...notes.map(n => `- ${n}`),
    '',
    `### billing usage\n\n${fenced(JSON.stringify(usage, null, 2))}`,
    '',
    `### billing plan\n\n${fenced(JSON.stringify(plan, null, 2))}`,
    '',
    `### Provisioned capacity per VM\n\n${fenced(perVm)}`,
    '',
  ].join('\n')

  await writeReport('disk-billing.md', report)
  process.stdout.write(`${report}\n`)
}

await main()
