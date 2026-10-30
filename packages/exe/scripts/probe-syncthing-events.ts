/**
 * Slice-18 probe: Syncthing disk-event semantics + scan-nudge latency on a
 * real exe.dev VM.
 *
 * Two REAL Syncthing device instances (separate homes/identities/DBs, the same
 * apt `syncthing` package the duet vm-image installs) share a folder over
 * loopback BEP on one VM — the exact transport shape production uses, where
 * peers dial `tcp://127.0.0.1:<bridgePort>` through the sync tunnel. Verified:
 *   - /rest/events/disk long-poll shape (id/globalID/type/data fields), the
 *     pre-filter mask, and per-subscription id continuity;
 *   - RemoteChangeDetected firing per applied remote item with `modifiedBy`,
 *     for sendreceive AND receiveonly (our mode:'read') folder types, for
 *     added/modified/deleted actions plus dir and symlink item types;
 *   - whether data.path is folder-relative and modifiedBy is the short or
 *     full device ID (both load-bearing for the slice-18 translation);
 *   - scan-nudge latency (write → POST /rest/db/scan → peer sees the change)
 *     vs. the fsWatcherDelayS=1 watcher baseline, and that /rest/db/scan is
 *     synchronous.
 *
 * Transport: this machine has no exe.dev account SSH key, so no SSH — Shelley
 * bootstraps a tiny exec server behind the VM's HTTPS proxy (the
 * probe-session-cgroup pattern) and everything else is driven through it with
 * a VM-scoped expiring API key. The Syncthing admin APIs are only ever
 * touched from INSIDE the VM (loopback, L14). VM tagged duet-test, deleted in
 * finally; leak-check covers only this run's VMs.
 *
 * Run from packages/exe:
 *   bun run --env-file=../../.env.local scripts/probe-syncthing-events.ts
 */
import { cleanup, createVm, makeContext, vmName } from './probe-common.ts'

// Runs ON the VM (bun, root) — emits one JSON document on stdout. No
// backticks or ${} inside: it is shipped base64-encoded as a template string.
const driver = `
import { readFileSync } from 'node:fs'

const A_HOME = '/tmp/st-a', B_HOME = '/tmp/st-b'
const A_GUI = 'http://127.0.0.1:8384', B_GUI = 'http://127.0.0.1:8385'
const A_LISTEN = 'tcp://127.0.0.1:22001', B_LISTEN = 'tcp://127.0.0.1:22002'
const A_DIR = '/tmp/st-a-folder', B_DIR = '/tmp/st-b-folder'
const FOLDER = 'probe-share'

const results = []
const samples = {}
const latencies = {}
const step = (name, pass, detail) => results.push({ step: name, pass, detail })

async function sh(cmd) {
  const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error('cmd failed (' + code + '): ' + cmd + '\\n' + err + out)
  return out.trim()
}

function apiKeyOf(home) {
  const xml = readFileSync(home + '/config.xml', 'utf8')
  const m = xml.match(/<apikey>([^<]+)<\\/apikey>/)
  if (!m) throw new Error('no apikey in ' + home)
  return m[1].trim()
}

async function api(gui, key, path, init) {
  const merged = Object.assign({}, init)
  merged.headers = Object.assign({ 'x-api-key': key }, (init && init.headers) || {})
  const response = await fetch(gui + path, merged)
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ' for ' + path + ': ' + (await response.text()))
  }
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text }
}

async function waitApi(gui, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return await api(gui, key, '/rest/system/status') } catch {}
    if (Date.now() > deadline) throw new Error('syncthing GUI never came up at ' + gui)
    await Bun.sleep(500)
  }
}

async function waitConnected(gui, key, peerId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const c = await api(gui, key, '/rest/system/connections')
      if (c.connections && c.connections[peerId] && c.connections[peerId].connected) return
    } catch {}
    if (Date.now() > deadline) throw new Error('peers never connected via ' + gui)
    await Bun.sleep(500)
  }
}

const collected = []
let cursor = 0
async function headDisk(gui, key) {
  const events = await api(gui, key, '/rest/events/disk?limit=1&timeout=1')
  cursor = events.length === 0 ? 0 : events[events.length - 1].id
}
async function waitDisk(gui, key, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remainingS = Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
    const events = await api(
      gui, key,
      '/rest/events/disk?since=' + cursor + '&timeout=' + Math.min(10, remainingS),
    )
    for (const event of events) {
      collected.push(event)
      cursor = event.id
      if (predicate(event)) return event
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for disk event')
  }
}
function isRemote(event, suffix, action) {
  return (
    event.type === 'RemoteChangeDetected' &&
    event.data && typeof event.data.path === 'string' &&
    event.data.path.endsWith(suffix) &&
    (action === undefined || event.data.action === action)
  )
}

async function scan(gui, key, sub) {
  const t0 = Date.now()
  await api(
    gui, key,
    '/rest/db/scan?folder=' + FOLDER + (sub === undefined ? '' : '&sub=' + encodeURIComponent(sub)),
    { method: 'POST' },
  )
  return Date.now() - t0
}

async function putConfig(gui, key, mutate) {
  const config = await api(gui, key, '/rest/config')
  mutate(config)
  await api(gui, key, '/rest/config', { method: 'PUT', body: JSON.stringify(config) })
  await api(gui, key, '/rest/system/restart', { method: 'POST' })
  await Bun.sleep(1000)
  await waitApi(gui, key, 60000)
}

// --- setup: two identities, hardened loopback config, one shared folder ---
// The exec server has no HOME; syncthing's locations init panics without one.
const version = await sh('HOME=/tmp syncthing --version')
await sh('HOME=/tmp syncthing generate --home=' + A_HOME + ' --no-default-folder')
await sh('HOME=/tmp syncthing generate --home=' + B_HOME + ' --no-default-folder')
await sh('mkdir -p ' + A_DIR + ' ' + B_DIR +
  ' && chown -R exedev:exedev ' + A_HOME + ' ' + B_HOME + ' ' + A_DIR + ' ' + B_DIR)
const aKey = apiKeyOf(A_HOME), bKey = apiKeyOf(B_HOME)
await sh('systemd-run --unit=probe-st-a --property=User=exedev --setenv=HOME=/home/exedev' +
  ' /usr/bin/syncthing --home=' + A_HOME + ' --gui-address=127.0.0.1:8384 --no-browser')
await sh('systemd-run --unit=probe-st-b --property=User=exedev --setenv=HOME=/home/exedev' +
  ' /usr/bin/syncthing --home=' + B_HOME + ' --gui-address=127.0.0.1:8385 --no-browser')
const aId = (await waitApi(A_GUI, aKey, 120000)).myID
const bId = (await waitApi(B_GUI, bKey, 120000)).myID

function baseConfig(config, listen, selfId, peerId, peerListen, dir) {
  config.options = Object.assign({}, config.options, {
    listenAddresses: [listen],
    globalAnnounceEnabled: false, localAnnounceEnabled: false,
    relaysEnabled: false, natEnabled: false,
    urAccepted: -1, crashReportingEnabled: false,
  })
  const devices = (config.devices || []).filter(d => d.deviceID !== peerId)
  devices.push({ deviceID: peerId, name: 'peer', addresses: [peerListen] })
  config.devices = devices
  config.folders = [{
    id: FOLDER, label: FOLDER, path: dir, type: 'sendreceive',
    devices: [{ deviceID: selfId }, { deviceID: peerId }],
    rescanIntervalS: 3600, fsWatcherEnabled: false, fsWatcherDelayS: 10,
  }]
}
await putConfig(A_GUI, aKey, c => baseConfig(c, A_LISTEN, aId, bId, B_LISTEN, A_DIR))
await putConfig(B_GUI, bKey, c => baseConfig(c, B_LISTEN, bId, aId, A_LISTEN, B_DIR))
await waitConnected(A_GUI, aKey, bId, 60000)
step('setup', true, 'A=' + aId.slice(0, 7) + ' B=' + bId.slice(0, 7) + ' connected on loopback')

// --- added: nudge path (watcher OFF, rescan 3600s → only the scan moves data)
await headDisk(B_GUI, bKey)
await sh('echo hello-1 > ' + A_DIR + '/file1.txt && chown exedev ' + A_DIR + '/file1.txt')
let t0 = Date.now()
latencies.scanPostAddedMs = await scan(A_GUI, aKey, 'file1.txt')
const added = await waitDisk(B_GUI, bKey, e => isRemote(e, 'file1.txt'), 60000)
latencies.nudgeAddedMs = Date.now() - t0
samples.added = added
step('RemoteChangeDetected fires per applied item (new file)',
  added.data.folder === FOLDER && typeof added.data.modifiedBy === 'string',
  JSON.stringify(added))
// Source-verified: disk-change events know only modified|deleted — there is
// no 'added' action (new files arrive as 'modified'). Pin what fires.
step('new files report action', added.data.action === 'modified' || added.data.action === 'added',
  'action=' + added.data.action)
step('modifiedBy identifies the writer device',
  aId === added.data.modifiedBy || aId.startsWith(added.data.modifiedBy),
  'modifiedBy=' + added.data.modifiedBy + ' writerFullId=' + aId)
step('data.path is folder-relative', added.data.path === 'file1.txt',
  'path=' + JSON.stringify(added.data.path))

// --- modified ---
await sh('echo hello-2 >> ' + A_DIR + '/file1.txt')
t0 = Date.now()
await scan(A_GUI, aKey, 'file1.txt')
const modified = await waitDisk(B_GUI, bKey, e => isRemote(e, 'file1.txt', 'modified'), 60000)
latencies.nudgeModifiedMs = Date.now() - t0
step('RemoteChangeDetected on modified', modified.data.type === 'file', JSON.stringify(modified))

// --- deleted ---
await sh('rm ' + A_DIR + '/file1.txt')
t0 = Date.now()
await scan(A_GUI, aKey, 'file1.txt')
const deleted = await waitDisk(B_GUI, bKey, e => isRemote(e, 'file1.txt', 'deleted'), 60000)
latencies.nudgeDeletedMs = Date.now() - t0
step('RemoteChangeDetected on deleted', true, JSON.stringify(deleted))

// --- dir + symlink item types ---
await sh('mkdir ' + A_DIR + '/subdir && chown exedev ' + A_DIR + '/subdir')
await scan(A_GUI, aKey, 'subdir')
const dirEvent = await waitDisk(B_GUI, bKey, e => isRemote(e, 'subdir'), 60000)
samples.dir = dirEvent
step('dir items report data.type=dir', dirEvent.data.type === 'dir', JSON.stringify(dirEvent))
await sh('ln -s subdir ' + A_DIR + '/alink')
await scan(A_GUI, aKey, 'alink')
const linkEvent = await waitDisk(B_GUI, bKey, e => isRemote(e, 'alink'), 60000)
samples.symlink = linkEvent
step('symlink items carry a distinct data.type', typeof linkEvent.data.type === 'string',
  JSON.stringify(linkEvent))

// --- LocalChangeDetected shape (the other half of the mask) ---
await sh('echo local > ' + B_DIR + '/local.txt && chown exedev ' + B_DIR + '/local.txt')
await scan(B_GUI, bKey, 'local.txt')
const local = await waitDisk(B_GUI, bKey,
  e => e.type === 'LocalChangeDetected' && e.data && e.data.path.endsWith('local.txt'), 60000)
samples.local = local
step('LocalChangeDetected for local writes',
  local.data.action === 'modified' || local.data.action === 'added', JSON.stringify(local))

// --- mask + id continuity over everything collected so far (B not restarted yet)
const ids = collected.map(e => e.id)
const contiguous = ids.every((id, i) => i === 0 || id === ids[i - 1] + 1)
step('disk subscription ids are consecutive (gap = loss)', contiguous, 'ids=' + ids.join(','))
const types = Array.from(new Set(collected.map(e => e.type)))
step('mask pre-filters to Local/RemoteChangeDetected only',
  types.every(t => t === 'LocalChangeDetected' || t === 'RemoteChangeDetected'),
  'types=' + types.join(','))
const shapeOk = collected.every(e =>
  typeof e.id === 'number' && typeof e.globalID === 'number' &&
  typeof e.time === 'string' && !Number.isNaN(Date.parse(e.time)) && typeof e.data === 'object')
step('event envelope shape (id, globalID, parseable time, data)', shapeOk,
  'checked ' + collected.length + ' events')

// --- watcher baseline: fsWatcherDelayS=1 (the slice-19 mirror config), no nudge
await putConfig(A_GUI, aKey, c => {
  c.folders[0].fsWatcherEnabled = true
  c.folders[0].fsWatcherDelayS = 1
})
await waitConnected(A_GUI, aKey, bId, 60000)
await Bun.sleep(3000) // let the watcher arm
await sh('echo baseline > ' + A_DIR + '/file2.txt && chown exedev ' + A_DIR + '/file2.txt')
t0 = Date.now()
const baseline = await waitDisk(B_GUI, bKey, e => isRemote(e, 'file2.txt'), 120000)
latencies.watcherBaselineMs = Date.now() - t0
step('watcher baseline delivered',
  baseline.data.action === 'modified' || baseline.data.action === 'added',
  'watcher fsWatcherDelayS=1 latency ' + latencies.watcherBaselineMs + 'ms')

// --- receiveonly folder (our mode:read) still fires RemoteChangeDetected ---
await putConfig(B_GUI, bKey, c => { c.folders[0].type = 'receiveonly' })
await waitConnected(B_GUI, bKey, aId, 60000)
await headDisk(B_GUI, bKey) // B restarted: subscription ids reset (L15 behavior)
await sh('echo ro > ' + A_DIR + '/file3.txt && chown exedev ' + A_DIR + '/file3.txt')
t0 = Date.now()
await scan(A_GUI, aKey, 'file3.txt')
const receiveOnly = await waitDisk(B_GUI, bKey, e => isRemote(e, 'file3.txt'), 60000)
latencies.nudgeReceiveonlyMs = Date.now() - t0
samples.receiveonly = receiveOnly
step('RemoteChangeDetected fires on receiveonly folders', true, JSON.stringify(receiveOnly))

console.log(JSON.stringify({ environment: { version }, latencies, samples, results }, null, 2))
if (results.some(r => !r.pass)) process.exit(1)
`

// Minimal exec server behind the VM's HTTPS proxy (port 8000) — the
// probe-session-cgroup transport, verbatim.
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

async function run(
  baseUrl: string,
  apiKey: string,
  cmd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const response = await vmFetch(baseUrl, apiKey, '/run', {
    method: 'POST',
    body: JSON.stringify({ cmd, timeoutMs }),
  })
  if (response.status !== 200) throw new Error(`exec server /run failed: HTTP ${response.status}`)
  return (await response.json()) as { code: number; stdout: string; stderr: string }
}

async function main() {
  const ctx = makeContext()
  const name = vmName('syncthing-events')
  let failure: unknown, cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()
    const createdVm = await createVm(ctx, { name, comment: 'duet slice-18 syncthing events probe' })
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

    // The exact package the duet vm-image installs (unpinned apt syncthing).
    const install = await run(
      baseUrl,
      apiKey,
      'DEBIAN_FRONTEND=noninteractive apt-get update -qq && ' +
        'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq syncthing >/dev/null && HOME=/tmp syncthing --version',
      420_000,
    )
    if (install.code !== 0) {
      throw new Error(`syncthing install failed (${install.code}):\n${install.stderr}`)
    }
    console.error(`installed: ${install.stdout.trim()}`)

    const driverRun = await run(
      baseUrl,
      apiKey,
      'mkdir -p /tmp/duet-probe && ' +
        `echo ${Buffer.from(driver).toString('base64')} | base64 -d > /tmp/duet-probe/driver.ts && ` +
        '/tmp/duet-bun/.bun/bin/bun /tmp/duet-probe/driver.ts',
      480_000,
    )
    const jsonStart = driverRun.stdout.indexOf('{')
    if (jsonStart < 0) {
      throw new Error(
        `driver produced no JSON. exit=${driverRun.code} stderr:\n${driverRun.stderr}\nstdout:\n${driverRun.stdout}`,
      )
    }
    const report = JSON.parse(driverRun.stdout.slice(jsonStart)) as {
      environment: { version: string }
      latencies: Record<string, number>
      samples: Record<string, unknown>
      results: Array<{ step: string; pass: boolean; detail: string }>
    }
    const allPass = report.results.every(r => r.pass) && driverRun.code === 0
    console.log(`# syncthing-events probe — VM ${name} (driver exit ${driverRun.code})`)
    console.log(JSON.stringify(report, null, 2))
    console.log(`Verdict: ${allPass ? 'GREEN' : 'RED'}`)
    if (!allPass) throw new Error('syncthing-events probe had failing steps')
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
