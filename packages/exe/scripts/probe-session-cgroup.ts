/**
 * Slice-08 probe: session-cgroup mechanics on a real exe.dev kernel.
 *
 * Ships the REAL gateway module (packages/gateway/src/runner/cgroup.ts) to a
 * fresh VM and drives its operations directly — no full duet gateway session:
 * unconditional parent setup (cpu budget), session-named leaf create + pid
 * placement, leaf↔session round-trip on cgroupfs, the kernel's EBUSY guard on
 * populated leaves, the exit-plus-drain teardown (real DRAIN_MS wait), and the
 * stale-leaf sweep a restarted gateway runs after a crash-leak. Evidence goes
 * into slices/08-session-cgroups.md (no research report for this slice).
 *
 * Transport: this machine has no exe.dev account SSH key (in-VM SSH auth
 * happens at the exe.dev edge against ACCOUNT keys — a VM-local
 * authorized_keys entry is never consulted), so the probe avoids SSH
 * entirely: Shelley (the stock in-VM agent) is prompted once to start a tiny
 * exec server on the proxy port, which the probe then drives
 * deterministically over the VM's HTTPS proxy with a VM-scoped, expiring API
 * key (`ssh-key generate-api-key --vm`, sent as `x-exedev-authorization` —
 * the same header duet's own retirement-archive flow uses). The key label is
 * removed in `finally`; nothing else outlives the VM, which is deleted there
 * too. (`--setup-script`/`--command` were tried first and never produced a
 * listener on this image, and stat/doc are outside this token's permissions.)
 */
import { cleanup, createVm, makeContext, vmName } from './probe-common.ts'

// Runs ON the VM (bun, root) and imports the real module uploaded next to it.
// Emits one JSON document on stdout.
const driver = `
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import {
  DRAIN_MS,
  cgroupLeafForSession,
  ensureRunnerCgroup,
  placeRunnerInCgroup,
  removeRunnerCgroupWhenDrained,
  sessionForCgroupLeaf,
  sweepStaleRunnerLeaves,
} from './cgroup.ts'

const RUNNERS = '/sys/fs/cgroup/runners'
const results: Array<{ step: string; pass: boolean; detail: string }> = []
const step = (name: string, pass: boolean, detail: string) =>
  results.push({ step: name, pass, detail })
const read = (path: string) => readFileSync(path, 'utf8').trim()
const sudo = async (script: string) => {
  const proc = Bun.spawn(['sudo', '-n', 'sh', '-c', script], { stderr: 'pipe' })
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stderr: stderr.trim() }
}
const holdOpen = (sessionId: string) => {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' })
  return { child, place: () => placeRunnerInCgroup(child.pid!, sessionId) }
}

// 1. Unconditional parent setup + CPU budget unchanged.
const ensured = await ensureRunnerCgroup()
const cpuMax = ensured ? read(RUNNERS + '/cpu.max') : '<missing>'
const subtree = ensured ? read(RUNNERS + '/cgroup.subtree_control') : '<missing>'
step(
  'ensureRunnerCgroup',
  ensured && subtree.includes('cpu'),
  'cpu.max=' + JSON.stringify(cpuMax) + ' subtree_control=' + JSON.stringify(subtree),
)

// 2. Hostile session id: leaf create + pid placement + kernel round-trip.
const sessionId = 'sess_probe/one two.α'
const leaf = cgroupLeafForSession(sessionId)
const runner = holdOpen(sessionId)
await runner.place()
const leafDir = RUNNERS + '/' + leaf
const procs = existsSync(leafDir + '/cgroup.procs') ? read(leafDir + '/cgroup.procs') : '<missing>'
step(
  'place pid in session leaf',
  procs === String(runner.child.pid),
  'leaf=' + leaf + ' cgroup.procs=' + JSON.stringify(procs),
)
step(
  'leaf round-trips via cgroupfs readdir name',
  sessionForCgroupLeaf(leaf) === sessionId,
  'sessionForCgroupLeaf(' + leaf + ')=' + JSON.stringify(sessionForCgroupLeaf(leaf)),
)

// 3. Kernel refuses to remove a populated leaf (protects drain races).
const busy = await sudo('rmdir ' + leafDir)
step(
  'rmdir of populated leaf refused',
  busy.code !== 0 && existsSync(leafDir),
  'exit=' + busy.code + ' stderr=' + JSON.stringify(busy.stderr),
)

// 4. Exit-plus-drain: leaf survives the drain window, then disappears.
runner.child.kill('SIGKILL')
await new Promise(resolve => runner.child.on('exit', resolve))
const drainStart = Date.now()
const drained = removeRunnerCgroupWhenDrained(sessionId)
await Bun.sleep(DRAIN_MS / 2)
const midDrain = existsSync(leafDir)
await drained
const drainedMs = Date.now() - drainStart
const afterDrain = existsSync(leafDir)
step(
  'drain teardown (DRAIN_MS=' + DRAIN_MS + ')',
  midDrain && !afterDrain && drainedMs >= DRAIN_MS,
  'leaf alive at +' + DRAIN_MS / 2 + 'ms=' + midDrain + ', gone after ' + drainedMs + 'ms=' + !afterDrain,
)

// 5. Crash-leak GC: leaked session leaves + legacy pid leaf swept; the active
// session's populated leaf and unknown shapes untouched.
const crashedLeaf = cgroupLeafForSession('sess_crashed')
const activeId = 'sess_active'
const activeLeaf = cgroupLeafForSession(activeId)
await sudo('mkdir -p ' + RUNNERS + '/' + crashedLeaf + ' ' + RUNNERS + '/31337 ' + RUNNERS + '/not-ours')
const active = holdOpen(activeId)
await active.place()
await sweepStaleRunnerLeaves(() => [activeId])
const sweepState = {
  crashed: existsSync(RUNNERS + '/' + crashedLeaf),
  legacyPid: existsSync(RUNNERS + '/31337'),
  unknown: existsSync(RUNNERS + '/not-ours'),
  active: existsSync(RUNNERS + '/' + activeLeaf),
}
step(
  'stale sweep GCs crash-leaked leaves only',
  !sweepState.crashed && !sweepState.legacyPid && sweepState.unknown && sweepState.active,
  JSON.stringify(sweepState),
)

active.child.kill('SIGKILL')
await new Promise(resolve => active.child.on('exit', resolve))
await sudo('rmdir ' + RUNNERS + '/' + activeLeaf + ' ' + RUNNERS + '/not-ours')

const environment = {
  kernel: read('/proc/sys/kernel/osrelease'),
  controllers: read('/sys/fs/cgroup/cgroup.controllers'),
  nproc: navigator.hardwareConcurrency,
  uid: process.getuid?.(),
}
console.log(JSON.stringify({ environment, results }, null, 2))
if (results.some(r => !r.pass)) process.exit(1)
`

// Minimal exec server behind the VM's HTTPS proxy (port 8000): POST /run with
// { cmd } runs it via sh and returns stdout/stderr/exit code. Lives only as
// long as the throwaway VM (Shelley starts it under systemd-run).
const execServer = `
Bun.serve({
  port: 8000,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname === '/run' && req.method === 'POST') {
      const body = (await req.json()) as { cmd: string; timeoutMs?: number }
      const proc = Bun.spawn(['sh', '-c', body.cmd], { stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => proc.kill(), body.timeoutMs ?? 90_000)
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      clearTimeout(timer)
      return Response.json({ code, stdout, stderr })
    }
    return new Response('not found', { status: 404 })
  },
})
`

/** Leak-check only the VMs this run created — other agents run their own duet-test VMs. */
async function assertOwnVmsDeleted(ctx: ReturnType<typeof makeContext>): Promise<void> {
  let leaked: string[] = []
  for (let attempt = 0; attempt < 10; attempt++) {
    const names = new Set((await ctx.control.list()).map(vm => vm.vm_name))
    leaked = ctx.created.filter(name => names.has(name))
    if (leaked.length === 0) return
    await Bun.sleep(1_000)
  }
  throw new Error(`This run's duet-test VMs remain: ${leaked.join(', ')}`)
}

async function vmFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/g, '')}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { ...init.headers, 'x-exedev-authorization': `Bearer ${apiKey}` },
  })
}

async function waitForExecServer(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await vmFetch(baseUrl, apiKey, '/healthz')
      if (response.status === 200 && (await response.text()) === 'ok') return
    } catch {
      // Boot/proxy not ready yet.
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for the in-VM exec server')
    await Bun.sleep(2_000)
  }
}

async function main() {
  const ctx = makeContext()
  const name = vmName('session-cgroup')
  let failure: unknown, cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()
    const createdVm = await createVm(ctx, { name, comment: 'duet slice-08 session-cgroup probe' })
    const baseUrl = createdVm.value.https_url
    if (!baseUrl) throw new Error('VM create response had no https_url')
    await ctx.control.waitUntilRunning(name, { timeoutMs: 180_000 })
    // Label must be unique per run: exe.dev rejects duplicate labels
    // account-wide even after the VM is gone. Removed in finally.
    const apiKey = await ctx.control.generateVmApiKey(name, name, '1d')

    const serverB64 = Buffer.from(execServer).toString('base64')
    const bootstrap =
      `echo ${serverB64} | base64 -d > /tmp/duet-probe-server.ts && ` +
      'curl -fsSL https://bun.sh/install | HOME=/tmp/duet-bun bash && ' +
      'sudo systemd-run --unit=duet-probe /tmp/duet-bun/.bun/bin/bun /tmp/duet-probe-server.ts'
    await ctx.control.shelleyPrompt(
      name,
      `Please run exactly this one shell command, without modifying it, then reply "done": ${bootstrap}`,
    )
    await waitForExecServer(baseUrl, apiKey, 360_000)

    const moduleSource = await Bun.file(
      new URL('../../gateway/src/runner/cgroup.ts', import.meta.url),
    ).text()
    const runResponse = await vmFetch(baseUrl, apiKey, '/run', {
      method: 'POST',
      body: JSON.stringify({
        cmd:
          'mkdir -p /tmp/duet-probe && ' +
          `echo ${Buffer.from(moduleSource).toString('base64')} | base64 -d > /tmp/duet-probe/cgroup.ts && ` +
          `echo ${Buffer.from(driver).toString('base64')} | base64 -d > /tmp/duet-probe/driver.ts && ` +
          '/tmp/duet-bun/.bun/bin/bun /tmp/duet-probe/driver.ts',
        timeoutMs: 90_000,
      }),
    })
    if (runResponse.status !== 200) {
      throw new Error(`exec server /run failed: HTTP ${runResponse.status}`)
    }
    const run = (await runResponse.json()) as { code: number; stdout: string; stderr: string }
    const jsonStart = run.stdout.indexOf('{')
    if (jsonStart < 0) {
      throw new Error(`driver produced no JSON. exit=${run.code} stderr:\n${run.stderr}`)
    }
    const { environment, results } = JSON.parse(run.stdout.slice(jsonStart)) as {
      environment: Record<string, unknown>
      results: Array<{ step: string; pass: boolean; detail: string }>
    }
    const allPass = results.every(r => r.pass) && run.code === 0
    console.log(`# session-cgroup probe — VM ${name} (driver exit ${run.code})`)
    console.log(`environment: ${JSON.stringify(environment)}`)
    for (const r of results) console.log(`- [${r.pass ? 'PASS' : 'FAIL'}] ${r.step}: ${r.detail}`)
    console.log(`Verdict: ${allPass ? 'GREEN' : 'RED'}`)
    if (!allPass) throw new Error('session-cgroup probe had failing steps')
  } catch (e) {
    failure = e
  } finally {
    const result = await cleanup(ctx)
    if (result.deleteErrors.length) cleanupFailure = new Error(result.deleteErrors.join('; '))
    try {
      await ctx.control.removeSshKey(name)
    } catch {
      // Key was never created.
    }
    try {
      await assertOwnVmsDeleted(ctx)
    } catch (e) {
      cleanupFailure = e instanceof Error ? e : new Error(String(e))
    }
    console.error(
      cleanupFailure
        ? `Cleaned ${result.deleted.join(', ')}; verification failed`
        : `Cleaned ${result.deleted.join(', ') || 'none'}; this run's VMs are gone`,
    )
  }
  if (cleanupFailure) throw cleanupFailure
  if (failure) throw failure
}

await main()
