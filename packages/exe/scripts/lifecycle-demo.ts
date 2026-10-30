/**
 * exe.dev long-lived lifecycle demo.
 *
 * The point of this script is to make the exe.dev vs e2b difference concrete.
 *
 * e2b `pause` takes a full memory snapshot: on resume, your running processes,
 * open file descriptors, and RAM are exactly as you left them. exe.dev has no
 * such thing — a VM is a persistent disk you reboot. So across a restart:
 *
 *   - files on disk SURVIVE (it's a normal filesystem, backed up)
 *   - in-memory state is LOST: background processes are gone, uptime resets,
 *     and the kernel boot_id changes.
 *
 * This script demonstrates exactly that, and times the reboot. It persists the
 * VM name to `.exe-state/` so reruns reconnect to the same VM.
 *
 * Usage:
 *   bun run scripts/lifecycle-demo.ts              # create/reconnect, restart, verify
 *   bun run scripts/lifecycle-demo.ts --cleanup    # delete the VM at the end
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { ExeClient, type ExeVm } from '../src/exe.ts'

const STATE_DIR = new URL('../.exe-state/', import.meta.url)
const STATE_FILE = new URL('../.exe-state/lifecycle-demo.json', import.meta.url)
// VMs SSH in as user `exedev`, not root — keep all state under $HOME.
const WORKDIR = '$HOME/exe-lifecycle'
const MARKER_PATH = `${WORKDIR}/marker.txt`

interface StoredState {
  vmName: string
  sshDest: string
  createdAt: string
}

function section(title: string): void {
  console.log(`\n========== ${title} ==========`)
}

async function loadState(): Promise<StoredState | null> {
  try {
    return JSON.parse(await readFile(fileURLToPath(STATE_FILE), 'utf8')) as StoredState
  } catch {
    return null
  }
}

async function saveState(state: StoredState): Promise<void> {
  await mkdir(fileURLToPath(STATE_DIR), { recursive: true })
  await writeFile(fileURLToPath(STATE_FILE), JSON.stringify(state, null, 2))
}

async function run(client: ExeClient, sshDest: string, command: string): Promise<string> {
  const result = await client.exec(sshDest, command)
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

async function connectOrCreate(
  client: ExeClient,
): Promise<{ vm: Pick<ExeVm, 'vm_name' | 'ssh_dest'>; created: boolean }> {
  const saved = await loadState()
  if (saved) {
    const existing = (await client.list()).find(v => v.vm_name === saved.vmName)
    if (existing) {
      return { vm: { vm_name: existing.vm_name, ssh_dest: existing.ssh_dest }, created: false }
    }
    console.log(`Stored VM '${saved.vmName}' no longer exists; creating a fresh one.`)
  }

  const vm = await client.create({
    name: `lifecycle-${Date.now().toString(36)}`,
    comment: '@repo/exe lifecycle demo',
  })
  await saveState({ vmName: vm.vm_name, sshDest: vm.ssh_dest, createdAt: new Date().toISOString() })
  return { vm: { vm_name: vm.vm_name, ssh_dest: vm.ssh_dest }, created: true }
}

async function main(): Promise<void> {
  const cleanup = process.argv.includes('--cleanup')
  // Token drives the control plane (create/restart/rm); the in-VM steps below
  // still require SSH access to the VM (EXE_TOKEN alone can't reach inside one).
  const client = new ExeClient({
    token: process.env.EXE_TOKEN,
    verbose: process.argv.includes('--verbose'),
  })

  try {
    await client.whoami()
  } catch (error) {
    throw new Error(
      `Not authenticated with exe.dev. Run \`ssh exe.dev\` once to register your key.\n` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const { vm, created } = await connectOrCreate(client)
  console.log(`${created ? 'Created' : 'Reconnected to'} VM ${vm.vm_name} (${vm.ssh_dest})`)

  section('Wait for SSH')
  const readyMs = await client.waitUntilReady(vm.ssh_dest)
  console.log(`SSH-ready in ${readyMs.toFixed(0)} ms`)

  section('Write disk state + start in-memory state')
  await run(client, vm.ssh_dest, `mkdir -p ${WORKDIR}`)
  const stamp = new Date().toISOString()
  await run(client, vm.ssh_dest, `printf '%s\\n' ${JSON.stringify(stamp)} > ${MARKER_PATH}`)
  // Start a background process and capture pre-restart in-memory facts.
  await run(client, vm.ssh_dest, `nohup sleep 100000 >/dev/null 2>&1 & echo $! > ${WORKDIR}/bg.pid`)
  const before = {
    marker: await run(client, vm.ssh_dest, `cat ${MARKER_PATH}`),
    bgPid: await run(client, vm.ssh_dest, `cat ${WORKDIR}/bg.pid`),
    bgStart: await processStartMarker(client, vm.ssh_dest),
    bgAlive: await run(
      client,
      vm.ssh_dest,
      `kill -0 "$(cat ${WORKDIR}/bg.pid)" 2>/dev/null && echo yes || echo no`,
    ),
    bootId: await run(client, vm.ssh_dest, `cat /proc/sys/kernel/random/boot_id`),
    uptime: await run(client, vm.ssh_dest, `cut -d. -f1 /proc/uptime`),
  }
  console.log(`  marker written:     ${before.marker}`)
  console.log(`  background pid:      ${before.bgPid} (alive: ${before.bgAlive})`)
  console.log(`  kernel boot_id:      ${before.bootId}`)
  console.log(`  uptime (s):          ${before.uptime}`)

  section('Restart (reboot from persistent disk — no memory restore)')
  const restartStart = performance.now()
  await client.restart(vm.vm_name)
  const restartReturnedMs = performance.now() - restartStart
  const restartReadyMs = await client.waitUntilReady(vm.ssh_dest, { timeoutMs: 180_000 })
  console.log(`  restart command returned in ${restartReturnedMs.toFixed(0)} ms`)
  console.log(`  SSH-ready again after      ${restartReadyMs.toFixed(0)} ms`)

  section('Verify: disk persisted, memory did not')
  const after = {
    marker: await run(client, vm.ssh_dest, `cat ${MARKER_PATH}`),
    bgStart: await processStartMarker(client, vm.ssh_dest),
    bgAlive: await run(
      client,
      vm.ssh_dest,
      `kill -0 "$(cat ${WORKDIR}/bg.pid)" 2>/dev/null && echo yes || echo no`,
    ),
    bootId: await run(client, vm.ssh_dest, `cat /proc/sys/kernel/random/boot_id`),
    uptime: await run(client, vm.ssh_dest, `cut -d. -f1 /proc/uptime`),
  }

  const diskPersisted = after.marker === before.marker
  const memoryLost = after.bgStart !== before.bgStart && after.bootId !== before.bootId

  console.log(`  marker after restart:  ${after.marker}`)
  console.log(
    `  DISK persisted:        ${diskPersisted ? 'YES ✅ (file survived reboot)' : 'NO ❌'}`,
  )
  console.log(
    `  background process:    ${memoryLost ? 'gone ✅' : `unexpected marker ${after.bgStart} ❓`}`,
  )
  console.log(
    `  kernel boot_id:        ${after.bootId} (${after.bootId !== before.bootId ? 'changed ✅' : 'unchanged ❓'})`,
  )
  console.log(`  uptime (s):            ${after.uptime} (reset from ${before.uptime})`)
  console.log(
    `\n  => ${diskPersisted && memoryLost ? 'Confirmed: exe.dev restart is a disk-persistent reboot with NO live-memory restore.' : 'Unexpected result — inspect above.'}`,
  )

  if (cleanup) {
    section('Cleanup')
    await client.remove(vm.vm_name)
    await saveState({ vmName: '', sshDest: '', createdAt: '' })
    console.log(`Deleted VM ${vm.vm_name}.`)
  } else {
    console.log(
      `\nVM ${vm.vm_name} left running. Re-run to reconnect, or pass --cleanup to delete.`,
    )
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

async function processStartMarker(client: ExeClient, sshDest: string): Promise<string> {
  return await run(
    client,
    sshDest,
    `pid="$(cat ${WORKDIR}/bg.pid 2>/dev/null || true)"; if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then awk '{print $22}' "/proc/$pid/stat"; else echo missing; fi`,
  )
}
