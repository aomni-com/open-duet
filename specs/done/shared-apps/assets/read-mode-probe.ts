#!/usr/bin/env bun
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = resolve('packages/syncthing-darwin-arm64/bin/syncthing')
const folderId = 'read-mode-proof'
const root = await mkdtemp(join(tmpdir(), 'duet-read-mode-proof-'))
const creatorHome = join(root, 'creator-home')
const viewerHome = join(root, 'viewer-home')
const creatorDir = join(root, 'creator')
const viewerDir = join(root, 'viewer')
const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()])
const [creatorGui, viewerGui, creatorListen, viewerListen] = ports
const children: Bun.Subprocess[] = []

try {
  await Promise.all([mkdir(creatorDir), mkdir(viewerDir)])
  generate(creatorHome)
  generate(viewerHome)
  const creatorKey = await hardenGeneratedConfig(creatorHome, creatorListen)
  const viewerKey = await hardenGeneratedConfig(viewerHome, viewerListen)
  children.push(start(creatorHome, creatorGui), start(viewerHome, viewerGui))
  const creator = api(creatorGui, creatorKey)
  const viewer = api(viewerGui, viewerKey)
  await Promise.all([waitForApi(creator), waitForApi(viewer)])

  const creatorId = (await creator.get('/rest/system/status')).myID as string
  const viewerId = (await viewer.get('/rest/system/status')).myID as string
  await configurePeer(creator, viewerId, viewerListen, creatorDir, 'sendonly')
  await configurePeer(viewer, creatorId, creatorListen, viewerDir, 'receiveonly')
  await waitFor(async () => {
    const status = await creator.get('/rest/system/connections')
    return Boolean((status.connections as Record<string, unknown>)[viewerId])
  })

  await writeCreator(creator, 'tracked.txt', 'creator-v1\n')
  await waitForFile(join(viewerDir, 'tracked.txt'), 'creator-v1\n')
  console.log('PASS 1a creator file auto-pushed to viewer')

  await writeFile(join(viewerDir, 'local-only.txt'), 'viewer-local\n')
  await scan(viewer, 'local-only.txt')
  await waitForLocalChange(viewer, 'local-only.txt')
  await selectiveRepair(viewer, viewerDir, 'local-only.txt')
  if ((await readFile(join(viewerDir, 'local-only.txt'), 'utf8')) !== 'viewer-local\n') fail()
  await Bun.sleep(500)
  if (await exists(join(creatorDir, 'local-only.txt'))) fail()
  console.log('PASS 2 viewer local addition survived and never reached creator')

  await writeCreator(creator, 'protected.txt', 'creator-protected\n')
  await waitForFile(join(viewerDir, 'protected.txt'), 'creator-protected\n')
  await writeFile(join(viewerDir, 'protected.txt'), 'viewer-edit\n')
  await scan(viewer, 'protected.txt')
  await selectiveRepair(viewer, viewerDir, 'protected.txt')
  await waitForFile(join(viewerDir, 'protected.txt'), 'creator-protected\n')
  const protectedConflict = await findConflict(viewerDir, 'protected')
  if ((await readFile(join(viewerDir, protectedConflict), 'utf8')) !== 'viewer-edit\n') fail()
  if ((await readFile(join(viewerDir, 'local-only.txt'), 'utf8')) !== 'viewer-local\n') fail()
  console.log('PASS 3a selective repair reverted a tracked modification only')

  await rm(join(viewerDir, 'protected.txt'))
  await scan(viewer, 'protected.txt')
  await selectiveRepair(viewer, viewerDir, 'protected.txt')
  await waitForFile(join(viewerDir, 'protected.txt'), 'creator-protected\n')
  if ((await readFile(join(viewerDir, 'local-only.txt'), 'utf8')) !== 'viewer-local\n') fail()
  console.log('PASS 3b selective repair restored a tracked deletion only')

  await writeFile(join(viewerDir, 'tracked.txt'), 'viewer-tracked-edit\n')
  await scan(viewer, 'tracked.txt')
  await writeCreator(creator, 'tracked.txt', 'creator-v2\n')
  await waitForFile(join(viewerDir, 'tracked.txt'), 'creator-v2\n')
  const trackedConflict = await findConflict(viewerDir, 'tracked')
  if ((await readFile(join(viewerDir, trackedConflict), 'utf8')) !== 'viewer-tracked-edit\n') fail()
  console.log('PASS 1b creator update won over viewer edit')
  console.log(`PASS 4a viewer edit preserved as ${trackedConflict}`)

  await writeFile(join(viewerDir, 'collision.txt'), 'viewer-collision\n')
  await scan(viewer, 'collision.txt')
  await writeCreator(creator, 'collision.txt', 'creator-collision\n')
  await waitForFile(join(viewerDir, 'collision.txt'), 'creator-collision\n')
  const collisionConflict = await findConflict(viewerDir, 'collision')
  if ((await readFile(join(viewerDir, collisionConflict), 'utf8')) !== 'viewer-collision\n') fail()
  console.log(`PASS 4b colliding local file preserved as ${collisionConflict}`)

  await writeFile(join(viewerDir, 'trap-local.txt'), 'must-survive-selective-enforcement\n')
  await scan(viewer, 'trap-local.txt')
  await waitForLocalChange(viewer, 'trap-local.txt')
  console.log('TRAP before folder revert: local addition present')
  await viewer.post(`/rest/db/revert?folder=${folderId}`)
  await waitFor(async () => !(await exists(join(viewerDir, 'trap-local.txt'))))
  console.log('TRAP after folder revert: local addition deleted')
  console.log('PAIRING creator=sendonly viewer=receiveonly')
  console.log('RESULT all read-mode constraints proven; folder-wide revert rejected')
} finally {
  await Promise.all(
    children.map(async child => {
      child.kill()
      await child.exited
    }),
  )
  await rm(root, { recursive: true, force: true })
}

function generate(home: string): void {
  const result = Bun.spawnSync([binary, 'generate', `--home=${home}`, '--no-port-probing'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if (result.exitCode !== 0) throw new Error(`Syncthing generate failed for ${home}`)
}

async function hardenGeneratedConfig(home: string, listenPort: number): Promise<string> {
  const path = join(home, 'config.xml')
  let xml = await readFile(path, 'utf8')
  const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1]
  if (apiKey === undefined) throw new Error('generated config has no API key')
  xml = xml
    .replace(
      '<listenAddress>default</listenAddress>',
      `<listenAddress>tcp://192.0.2.1:${listenPort}</listenAddress>`,
    )
    .replace(
      '<globalAnnounceEnabled>true</globalAnnounceEnabled>',
      '<globalAnnounceEnabled>false</globalAnnounceEnabled>',
    )
    .replace(
      '<localAnnounceEnabled>true</localAnnounceEnabled>',
      '<localAnnounceEnabled>false</localAnnounceEnabled>',
    )
    .replace('<relaysEnabled>true</relaysEnabled>', '<relaysEnabled>false</relaysEnabled>')
    .replace('<natEnabled>true</natEnabled>', '<natEnabled>false</natEnabled>')
  await writeFile(path, xml)
  return apiKey
}

function start(home: string, guiPort: number): Bun.Subprocess {
  return Bun.spawn(
    [
      binary,
      'serve',
      `--home=${home}`,
      '--no-browser',
      '--no-restart',
      `--gui-address=192.0.2.1:${guiPort}`,
      '--log-file=-',
    ],
    { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, STNOUPGRADE: '1' } },
  )
}

function api(port: number, key: string) {
  const base = `http://192.0.2.1:${port}`
  const headers = { 'x-api-key': key, 'content-type': 'application/json' }
  return {
    async get(path: string): Promise<Record<string, any>> {
      const response = await fetch(`${base}${path}`, { headers })
      if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
      return (await response.json()) as Record<string, any>
    },
    async put(path: string, body: unknown): Promise<void> {
      const response = await fetch(`${base}${path}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`PUT ${path}: HTTP ${response.status}`)
    },
    async post(path: string): Promise<void> {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers })
      if (!response.ok) throw new Error(`POST ${path}: HTTP ${response.status}`)
    },
  }
}

type Api = ReturnType<typeof api>

async function configurePeer(
  client: Api,
  peerId: string,
  peerPort: number,
  path: string,
  type: 'sendonly' | 'receiveonly',
): Promise<void> {
  const config = await client.get('/rest/config')
  config.options.globalAnnounceEnabled = false
  config.options.localAnnounceEnabled = false
  config.options.relaysEnabled = false
  config.options.natEnabled = false
  config.devices = [
    {
      deviceID: peerId,
      name: type === 'sendonly' ? 'viewer' : 'creator',
      addresses: [`tcp://192.0.2.1:${peerPort}`],
    },
  ]
  config.folders = [
    {
      id: folderId,
      label: folderId,
      path,
      type,
      devices: [{ deviceID: peerId }],
      rescanIntervalS: 1,
      fsWatcherEnabled: true,
      maxConflicts: 10,
    },
  ]
  await client.put('/rest/config', config)
}

async function writeCreator(client: Api, name: string, contents: string): Promise<void> {
  await writeFile(join(creatorDir, name), contents)
  await scan(client, name)
}

async function scan(client: Api, name: string): Promise<void> {
  const params = new URLSearchParams({ folder: folderId, sub: name })
  await client.post(`/rest/db/scan?${params}`)
}

async function selectiveRepair(client: Api, rootDir: string, name: string): Promise<void> {
  const params = new URLSearchParams({ folder: folderId, file: name })
  const info = await client.get(`/rest/db/file?${params}`)
  if (info.global?.localFlags !== 0 || info.global?.deleted === true) return
  if (info.local?.localFlags === 0 || info.local?.localFlags === undefined) return
  const path = join(rootDir, name)
  if (info.local.deleted === true) {
    await writeFile(path, '')
    await scan(client, name)
    await rm(path, { recursive: true, force: true })
  } else {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    const digits = new Date().toISOString().replace(/[-:T]/g, '')
    const timestamp = `${digits.slice(0, 8)}-${digits.slice(8, 14)}`
    const modifiedBy = String(info.global.modifiedBy ?? 'CREATOR')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 7)
    await rename(
      path,
      join(rootDir, `${stem}.sync-conflict-${timestamp}-${modifiedBy}${extension}`),
    )
  }
  await scan(client, name)
}

async function waitForLocalChange(client: Api, name: string): Promise<void> {
  await waitFor(async () => {
    const changed = await client.get(`/rest/db/localchanged?folder=${folderId}`)
    return (changed.files as Array<{ name: string }>).some(file => file.name === name)
  })
}

async function findConflict(dir: string, stem: string): Promise<string> {
  let found = ''
  await waitFor(async () => {
    found = (await readdir(dir)).find(name => name.startsWith(`${stem}.sync-conflict-`)) ?? ''
    return found !== ''
  })
  return found
}

async function waitForFile(path: string, expected: string): Promise<void> {
  await waitFor(async () => (await readFile(path, 'utf8').catch(() => '')) === expected)
}

async function waitForApi(client: Api): Promise<void> {
  await waitFor(async () => {
    try {
      await client.get('/rest/system/status')
      return true
    } catch {
      return false
    }
  })
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error('timed out waiting for Syncthing convergence')
}

async function exists(path: string): Promise<boolean> {
  return await readFile(path).then(
    () => true,
    () => false,
  )
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '192.0.2.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      server.close(error => (error === undefined ? resolvePort(address.port) : reject(error)))
    })
  })
}

function fail(): never {
  throw new Error('probe assertion failed')
}
