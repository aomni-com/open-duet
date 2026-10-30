/**
 * Local end-to-end probe for the Mac sync wrapper (spec file-attribution slice
 * 21). Runs the REAL production modules — supervisor, bridge (with L23
 * re-minting through a real WS tunnel), orchestrator config, status — against
 * TWO real Syncthing v2.1.2 instances on this machine:
 *
 *   Mac instance (dial-only, via createSupervisor)  --dials-->  loopback bridge
 *     --WS tunnel (real token, re-minted)-->  VM instance (plain listener)
 *
 * It exercises everything that does not require a provisioned exe.dev VM +
 * Convex: clone of a dev-shaped fixture (worktree files + a symlink; .git and
 * node_modules excluded per G1), bidirectional convergence, a real
 * `.sync-conflict-*` on a two-sided edit, and kill -9 mid-run → clean resume.
 *
 * The one-command clone, the `mirror:<machineId>` activity row, and the true
 * gateway tunnel are the documented runbook steps against a real VM (see the
 * slice Result).
 *
 * Run:  DUET_SYNCTHING_BIN=/path/to/syncthing bun packages/duet/scripts/sync-e2e-probe.ts
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MIRROR_FOLDER_ID, DEFAULT_MIRROR_IGNORE_PATTERNS } from '@repo/contract'
import {
  decodeTunnelFrame,
  deriveTunnelToken,
  encodeTunnelFrame,
  verifyTunnelToken,
} from '@repo/sync-tunnel'

import { ApiClient } from '../src/http.js'
import { startMirrorBridge } from '../src/sync/bridge.js'
import { workspaceSyncKey } from '../src/sync/daemon-status.js'
import { createRealMirrorStarter } from '../src/sync/mirror.js'
import { configureLocalMirror } from '../src/sync/orchestrator.js'
import { listConflicts, waitForConvergence } from '../src/sync/status.js'
import { createSupervisor } from '../src/sync/supervisor.js'
import {
  folderStatus,
  getConfig,
  myDeviceId,
  ping,
  putConfig,
  scanFolder,
  setFolderIgnores,
  type SyncthingApi,
} from '../src/sync/syncthing-api.js'

const BIN = process.env.DUET_SYNCTHING_BIN
if (!BIN) throw new Error('Set DUET_SYNCTHING_BIN to a Syncthing v2.1.2 binary')
const SECRET = 'e2e-tunnel-secret'
const claims = {
  sourceWorkspaceId: 'mac',
  targetWorkspaceId: 'vm',
  direction: 'source-to-target' as const,
}

const log = (m: string): void => console.log(`[probe] ${m}`)
const cleanups: Array<() => Promise<void> | void> = []

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'duet-sync-e2e-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const vmHome = join(root, 'vm-home')
  const vmDrive = join(root, 'vm-drive')
  const macHome = join(root, 'mac-home')
  const macDrive = join(root, 'mac-drive')

  // --- Fixture: a dev-shaped workspace on the VM drive ------------------------
  await mkdir(join(vmDrive, 'src'), { recursive: true })
  await writeFile(join(vmDrive, 'README.md'), '# workspace\noriginal\n')
  await writeFile(join(vmDrive, 'src', 'app.ts'), 'export const x = 1\n')
  await symlink(join('src', 'app.ts'), join(vmDrive, 'link.ts'))
  await mkdir(join(vmDrive, '.git'), { recursive: true })
  await writeFile(join(vmDrive, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await mkdir(join(vmDrive, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(vmDrive, 'node_modules', 'pkg', 'index.js'), 'module.exports=1\n')

  // --- VM-role Syncthing (plain loopback listener) ---------------------------
  const vmGui = await freePort()
  const vmBep = await freePort()
  const vmApi = await startVmInstance(vmHome, vmGui, vmBep)
  const vmDeviceId = await myDeviceId(vmApi)
  log(`VM device ${vmDeviceId.slice(0, 7)} up on 127.0.0.1:${vmGui} (BEP ${vmBep})`)

  // --- Mac-role Syncthing via the REAL supervisor (dial-only) ----------------
  const macGui = await freePort()
  const identityHome = join(root, 'mac-identity')
  const supervisor = createSupervisor({
    home: macHome,
    identityHome,
    binaryPath: BIN!,
    guiPort: macGui,
  })
  cleanups.push(() => supervisor.stop())
  const macApi = await supervisor.start()
  const macDeviceId = await supervisor.deviceId()
  log(`Mac device ${macDeviceId.slice(0, 7)} up on 127.0.0.1:${macGui} (dial-only)`)
  const secondMac = createSupervisor({
    home: join(root, 'mac-second-workspace'),
    identityHome,
    binaryPath: BIN!,
    guiPort: await freePort(),
  })
  cleanups.push(() => secondMac.stop())
  await secondMac.start()
  assert(
    (await secondMac.deviceId()) === macDeviceId,
    'both workspace instances use one Mac peer identity',
  )
  assert(
    (await readFile(join(macHome, 'cert.pem'))).equals(
      await readFile(join(root, 'mac-second-workspace', 'cert.pem')),
    ),
    'both workspace instances copy the same certificate',
  )
  await secondMac.stop()
  log('Two workspace instances share one Mac certificate and Syncthing peer ID')

  assert(
    !(await readFile(join(macHome, 'config.xml'), 'utf8')).includes('<listenAddress>default'),
    'Mac config is dial-only (no default listener)',
  )

  // --- Real WS tunnel + bridge with L23 re-minting ---------------------------
  const tunnel = startTunnelServer(vmBep)
  cleanups.push(() => tunnel.stop(true))
  let mints = 0
  const bridge = await startMirrorBridge({
    remintSafetyMs: 2_000,
    mintTunnel: async () => {
      mints += 1
      return {
        url: `${tunnel.url}accept`.replace('http:', 'ws:'),
        tunnelToken: await deriveTunnelToken({ secret: SECRET, claims }),
        expiresAt: Date.now() + 4_000,
      }
    },
  })
  cleanups.push(() => bridge.close())
  log(`Bridge on 127.0.0.1:${bridge.port} (mint #${mints})`)

  // --- Orchestrate: VM trusts Mac + shares folder; Mac mirrors it ------------
  await mkdir(macDrive, { recursive: true })
  await addDeviceAndShare(vmApi, vmDeviceId, macDeviceId, MIRROR_FOLDER_ID, vmDrive)
  await setFolderIgnores(vmApi, MIRROR_FOLDER_ID, DEFAULT_MIRROR_IGNORE_PATTERNS)
  await configureLocalMirror(macApi, {
    folderId: MIRROR_FOLDER_ID,
    localDeviceId: macDeviceId,
    vmDeviceId,
    bridgePort: bridge.port,
    localDir: macDrive,
  })
  await scanFolder(vmApi, MIRROR_FOLDER_ID)
  await scanFolder(macApi, MIRROR_FOLDER_ID)

  // --- Converge & assert the clone shape (G1 exclusions) ---------------------
  let lastSnap = ''
  const converged = await waitForConvergence(macApi, {
    folderId: MIRROR_FOLDER_ID,
    vmDeviceId,
    timeoutMs: 60_000,
    pollMs: 1_000,
    onSnapshot: s => {
      const line = `connected=${s.connected} state=${s.localState} global=${s.globalItems} need=${s.localNeedItems} remote=${s.remoteCompletion}%`
      if (line !== lastSnap) {
        log(`  snapshot: ${line}`)
        lastSnap = line
      }
    },
  })
  if (!converged.converged) {
    const status = await folderStatus(macApi, MIRROR_FOLDER_ID)
    log(`  DIAG mac folderStatus: ${JSON.stringify(status)}`)
  }
  assert(converged.converged, `converged (connected=${converged.connected})`)
  assert(await exists(join(macDrive, 'README.md')), 'README.md cloned to the Mac')
  assert(await exists(join(macDrive, 'src', 'app.ts')), 'src/app.ts cloned to the Mac')
  assert(await isSymlink(join(macDrive, 'link.ts')), 'link.ts cloned as a SYMLINK')
  assert(!(await exists(join(macDrive, '.git'))), '.git excluded (G1)')
  assert(!(await exists(join(macDrive, 'node_modules'))), 'node_modules excluded (G1)')
  assert(
    mints >= 2,
    `bridge re-minted the tunnel token (mints=${mints}, remints=${bridge.remints()})`,
  )

  // --- Two-sided edit → a real .sync-conflict-* ------------------------------
  // Split-brain the two sides, edit the same file differently, reconnect.
  await bridge.close()
  await writeFile(join(vmDrive, 'README.md'), '# workspace\nVM edit\n')
  await writeFile(join(macDrive, 'README.md'), '# workspace\nMac edit\n')
  await scanFolder(vmApi, MIRROR_FOLDER_ID)
  await scanFolder(macApi, MIRROR_FOLDER_ID)
  const bridge2 = await startMirrorBridge({
    mintTunnel: async () => ({
      url: `${tunnel.url}accept`.replace('http:', 'ws:'),
      tunnelToken: await deriveTunnelToken({ secret: SECRET, claims }),
      expiresAt: Date.now() + 5 * 60_000,
    }),
  })
  cleanups.push(() => bridge2.close())
  // Point the Mac's VM-device address at the new bridge port.
  await configureLocalMirror(macApi, {
    folderId: MIRROR_FOLDER_ID,
    localDeviceId: macDeviceId,
    vmDeviceId,
    bridgePort: bridge2.port,
    localDir: macDrive,
  })
  const conflicts = await waitForCondition(
    async () => {
      const found = await listConflicts(macDrive)
      return found.length > 0 ? found : null
    },
    45_000,
    'a .sync-conflict-* file to appear',
  )
  assert(conflicts.length > 0, `conflict surfaced (never auto-resolved): ${conflicts.join(', ')}`)

  // --- kill -9 the Mac instance mid-run → supervisor resumes -----------------
  const beforeRestarts = supervisor.restarts()
  const macPid = await currentMacPid(macHome)
  process.kill(macPid, 'SIGKILL')
  log(`kill -9 ${macPid} (Mac Syncthing)`)
  await waitForCondition(
    async () => (supervisor.restarts() > beforeRestarts ? true : null),
    20_000,
    'supervisor to restart the killed instance',
  )
  await waitForCondition(
    async () => ((await ping(macApi)) ? true : null),
    30_000,
    'Mac REST back up',
  )
  const resumed = await waitForConvergence(macApi, {
    folderId: MIRROR_FOLDER_ID,
    vmDeviceId,
    timeoutMs: 60_000,
    pollMs: 500,
  })
  assert(resumed.converged, 'clean resume after kill -9 (Syncthing owns resumability)')

  await bridge2.close()
  await supervisor.stop()
  log('Mirror resources close cleanly (supervisor stopped, bridge closed)')
  const refusalServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: 'not_found' }, { status: 404 }),
  })
  cleanups.push(() => refusalServer.stop(true))
  const refusedGui = await freePort()
  const refusedStarter = createRealMirrorStarter({
    api: new ApiClient({ baseUrl: refusalServer.url.toString(), apiKey: 'scratch-user-key' }),
    machineId: 'machine_scratch',
    home: join(root, 'refused-user'),
    binaryPath: BIN!,
    fetch,
    allocatePort: async () => refusedGui,
  })
  let refused = false
  try {
    await refusedStarter({
      slug: 'offline',
      syncKey: workspaceSyncKey(refusalServer.url.toString(), 'offline-fixture'),
      localDir: join(root, 'refused-drive'),
      log: () => {},
    })
  } catch (error) {
    refused = error instanceof Error && error.message === 'Not found.'
  }
  assert(refused, 'a mirror registration refusal reaches the caller')
  let stopped = false
  try {
    await fetch(`http://127.0.0.1:${refusedGui}/rest/system/ping`)
  } catch {
    stopped = true
  }
  assert(stopped, 'registration failure stops the already-started Syncthing process')
  log('ALL E2E ASSERTIONS PASSED')
}

// ---------------------------------------------------------------------------

async function startVmInstance(
  home: string,
  guiPort: number,
  bepPort: number,
): Promise<SyncthingApi> {
  await mkdir(home, { recursive: true })
  await run([BIN!, 'generate', `--home=${home}`])
  const cfgPath = join(home, 'config.xml')
  let xml = await readFile(cfgPath, 'utf8')
  const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/)![1]!
  xml = xml
    .replace(
      /<listenAddress>[^<]*<\/listenAddress>/g,
      `<listenAddress>tcp://127.0.0.1:${bepPort}</listenAddress>`,
    )
    .replace(/<globalAnnounceEnabled>[^<]*</, '<globalAnnounceEnabled>false<')
    .replace(/<localAnnounceEnabled>[^<]*</, '<localAnnounceEnabled>false<')
    .replace(/<relaysEnabled>[^<]*</, '<relaysEnabled>false<')
    .replace(/<natEnabled>[^<]*</, '<natEnabled>false<')
    .replace(/<startBrowser>[^<]*</, '<startBrowser>false<')
    .replace(/<address>127\.0\.0\.1:8384<\/address>/, `<address>127.0.0.1:${guiPort}</address>`)
  await writeFile(cfgPath, xml)
  const proc = Bun.spawn([BIN!, 'serve', '--no-browser', '--no-restart', `--home=${home}`], {
    env: { ...process.env, STNOUPGRADE: '1' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  cleanups.push(() => {
    proc.kill(9)
  })
  const api: SyncthingApi = { base: `http://127.0.0.1:${guiPort}`, apiKey, fetch }
  await waitForCondition(async () => ((await ping(api)) ? true : null), 30_000, 'VM REST up')
  return api
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function addDeviceAndShare(
  api: SyncthingApi,
  selfId: string,
  peerId: string,
  folderId: string,
  path: string,
): Promise<void> {
  const config = await getConfig(api)
  config.devices ??= []
  if (!config.devices.some(d => d.deviceID === peerId)) {
    config.devices.push({ deviceID: peerId, name: 'mac', addresses: ['dynamic'] })
  }
  config.folders ??= []
  config.folders = config.folders.filter(f => f.id !== folderId)
  config.folders.push({
    id: folderId,
    label: 'Workspace drive',
    path,
    type: 'sendreceive',
    fsWatcherEnabled: true,
    fsWatcherDelayS: 1,
    ignorePerms: false,
    maxConflicts: 10,
    devices: [{ deviceID: selfId }, { deviceID: peerId }],
  })
  await putConfig(api, config)
}

function startTunnelServer(targetPort: number): ReturnType<typeof Bun.serve> {
  return Bun.serve<{ socket?: import('node:net').Socket }>({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname !== '/accept') return new Response('not found', { status: 404 })
      const token = request.headers.get('x-duet-tunnel-token')
      if (token === null || !(await verifyTunnelToken({ secret: SECRET, claims, token }))) {
        return new Response('unauthorized', { status: 401 })
      }
      return server.upgrade(request, { data: {} }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open(ws) {
        const socket = createConnection({ host: '127.0.0.1', port: targetPort })
        ws.data.socket = socket
        socket.on('data', chunk =>
          ws.send(toArrayBuffer(encodeTunnelFrame({ type: 'data', payload: toBytes(chunk) }))),
        )
        socket.on('close', () => ws.close())
        socket.on('error', () => ws.close())
      },
      message(ws, message) {
        const frame = decodeTunnelFrame(toBytes(message as Buffer))
        if (frame.type === 'data') ws.data.socket?.write(frame.payload)
      },
      close(ws) {
        ws.data.socket?.end()
      },
    },
  })
}

async function currentMacPid(home: string): Promise<number> {
  // Syncthing writes its own PID under the home.
  for (const name of ['syncthing.pid', join('index-v0.14.0.db', 'syncthing.pid')]) {
    try {
      const pid = Number((await readFile(join(home, name), 'utf8')).trim())
      if (Number.isFinite(pid) && pid > 0) return pid
    } catch {
      /* try next */
    }
  }
  // Fallback: find by home path in the process table.
  const proc = Bun.spawnSync(['pgrep', '-f', `serve.*${home}`])
  const pid = Number(new TextDecoder().decode(proc.stdout).trim().split('\n')[0])
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('could not find Mac Syncthing pid')
  return pid
}

async function run(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${argv.join(' ')} exited ${code}`)
}

async function waitForCondition<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await Bun.sleep(300)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    // A directory read fails with EISDIR — that still means it exists.
    return (error as NodeJS.ErrnoException).code === 'EISDIR'
  }
}

async function isSymlink(path: string): Promise<boolean> {
  const { lstat } = await import('node:fs/promises')
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  log(`ok: ${message}`)
}

function toBytes(message: string | Buffer): Uint8Array {
  if (typeof message === 'string') return new TextEncoder().encode(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

void (async () => {
  try {
    await main()
    process.exitCode = 0
  } catch (error) {
    console.error(`[probe] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        /* best effort */
      }
    }
    // Give killed children a moment to reap.
    await Bun.sleep(200)
  }
})()
