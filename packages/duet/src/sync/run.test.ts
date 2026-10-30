import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandRegistry, createCommandContext } from '../cli-support.js'
import { configPathForHome, saveConfig } from '../config.js'
import { macIdentityHome } from './machine.js'
import { registerSyncCommands } from './run.js'

async function daemonKeyChange(overrides: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'duet-sync-command-'))
  try {
    const configPath = configPathForHome(home)
    await saveConfig(
      { apiKey: 'key-one', apiUrl: 'https://one.example', machineId: 'machine_mac' },
      configPath,
    )
    const binary = join(home, 'syncthing')
    await writeFile(binary, '#!/bin/sh\nprintf "syncthing v2.1.2\\n"\n')
    await chmod(binary, 0o700)
    const requests: Array<{ url: string; authorization: string | null; method: string }> = []
    let clock = 0
    let changed = false
    let reconciles = 0
    const { ctx } = await createCommandContext([], {
      home,
      env: { DUET_SYNCTHING_BIN: binary, ...overrides },
      now: () => clock,
      sleep: async ms => {
        clock += ms
        if (!changed) {
          changed = true
          await saveConfig(
            { apiKey: 'key-two', apiUrl: 'https://two.example', machineId: 'machine_mac' },
            configPath,
          )
        }
      },
      io: {
        stdout: {
          write() {
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      },
      fetch: async (input, init) => {
        const url = String(input)
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
          method: init?.method ?? 'GET',
        })
        if (url.includes('/user/sync-machines')) {
          if (++reconciles === 2) process.emit('SIGTERM')
          return Response.json({
            items: [
              {
                machineId: 'machine_mac',
                name: 'Mac',
                syncthingDeviceId: 'AAAAAAA-BBBBBBB',
                createdAt: 1,
                lastUsedAt: 1,
              },
            ],
            nextCursor: null,
          })
        }
        return Response.json({
          user: { id: 'user_1', email: 'user@example.com' },
          workspaces: [],
          scopes: [],
          versions: { api: 1 },
          internalAdmin: false,
        })
      },
    })
    const registry = new CommandRegistry()
    registerSyncCommands(registry)
    await registry.dispatch(['sync', 'daemon'], ctx)
    const checks = requests.filter(request => request.url.includes('/user/sync-machines'))
    return { checks, requests }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('the daemon observes replacement login and origin through the shared config', async () => {
  const { checks, requests } = await daemonKeyChange()
  expect(checks).toEqual([
    {
      url: 'https://one.example/v1/user/sync-machines?limit=100',
      authorization: 'Bearer key-one',
      method: 'GET',
    },
    {
      url: 'https://two.example/v1/user/sync-machines?limit=100',
      authorization: 'Bearer key-two',
      method: 'GET',
    },
  ])
  expect(requests.every(request => request.method === 'GET')).toBe(true)
})

test('the daemon preserves explicit key and API-origin overrides after saved login changes', async () => {
  const { checks } = await daemonKeyChange({
    DUET_API_KEY: 'explicit-key',
    DUET_API_URL: 'https://override.example',
  })
  expect(checks).toEqual([
    {
      url: 'https://override.example/v1/user/sync-machines?limit=100',
      authorization: 'Bearer explicit-key',
      method: 'GET',
    },
    {
      url: 'https://override.example/v1/user/sync-machines?limit=100',
      authorization: 'Bearer explicit-key',
      method: 'GET',
    },
  ])
})

async function runningAccountSwitch({
  sameWorkspaceId = false,
  sameOrigin = false,
  foreground = '',
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'duet-sync-account-'))
  const configPath = configPathForHome(home)
  const binary = join(home, 'syncthing')
  const pidsPath = join(home, 'pids')
  const registrations: Array<{ authorization: string | null; machineId: string }> = []
  const identities: Array<{ url: string; authorization: string | null }> = []
  const bridgePorts: number[] = []
  const mirrorDirs: string[] = []
  const secondOrigin = sameOrigin ? 'https://one.example' : 'https://two.example'
  let clock = 0
  let reconciles = 0
  let changed = false
  let oldProcessStopped = false
  let oldBridgeClosed = false
  let startedEngines = 0
  const localDir = join(home, 'chosen-transfer-directory')
  try {
    await saveConfig(
      { apiKey: 'key-one', apiUrl: 'https://one.example', machineId: 'machine-one' },
      configPath,
    )
    await mkdir(macIdentityHome(home), { recursive: true })
    await writeFile(join(macIdentityHome(home), 'cert.pem'), 'shared-certificate')
    await writeFile(join(macIdentityHome(home), 'key.pem'), 'shared-private-key')
    await writeFile(
      join(home, 'config.xml'),
      await readFile(new URL('./__fixtures__/generated-config.xml', import.meta.url)),
    )
    await writeFile(
      binary,
      `#!/bin/sh
case "$1" in
  --version) printf 'syncthing v2.1.2\\n' ;;
  generate) cp "$(dirname "$0")/config.xml" "\${2#--home=}/config.xml" ;;
  device-id) printf 'AAAAAAA-BBBBBBB\\n' ;;
  serve)
    for arg in "$@"; do case "$arg" in --home=*) printf '%s\\n' "\${arg#--home=}" >> "$(dirname "$0")/engine-homes" ;; esac; done
    printf '%s\\n' "$$" >> "$(dirname "$0")/pids"
    exec sleep 3600 ;;
  *) exit 1 ;;
esac
`,
    )
    await chmod(binary, 0o700)
    const contextOptions: Parameters<typeof createCommandContext>[1] = {
      home,
      env: { DUET_SYNCTHING_BIN: binary },
      now: () => clock,
      sleep: async ms => {
        clock += ms
        if (bridgePorts.length === 2 || reconciles >= 3) process.emit('SIGTERM')
      },
      io: {
        stdout: { write: () => true },
        stderr: {
          write: () => true,
        },
      },
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.hostname === '127.0.0.1') {
          if (url.pathname === '/rest/config' && init?.method === 'PUT') {
            const config = JSON.parse(String(init.body))
            const folder = config.folders[0]
            mirrorDirs.push(folder.path)
            bridgePorts.push(Number(new URL(config.devices[0].addresses[0]).port))
            if (mirrorDirs.length === 1) {
              await writeFile(join(folder.path, 'first-workspace.txt'), 'first workspace files')
              const engineHome = (await readFile(join(home, 'engine-homes'), 'utf8')).trim()
              await writeFile(join(engineHome, 'first-workspace.db'), 'first workspace database')
            }
          }
          if (url.pathname === '/rest/system/ping') {
            startedEngines += 1
            const deadline = Date.now() + 1_000
            for (;;) {
              const pids = await readFile(pidsPath, 'utf8').catch(() => '')
              if (pids.trim().split('\n').filter(Boolean).length >= startedEngines) break
              if (Date.now() >= deadline) throw new Error('Fixture engine did not start')
              await new Promise(resolve => setTimeout(resolve, 1))
            }
          }
          if (url.pathname === '/rest/system/status')
            return Response.json({ myID: 'AAAAAAA-BBBBBBB' })
          if (url.pathname === '/rest/db/status')
            return Response.json({ state: 'idle', globalTotalItems: 1 })
          if (url.pathname === '/rest/db/completion') return Response.json({ completion: 100 })
          if (url.pathname === '/rest/system/connections')
            return Response.json({ connections: { vm: { connected: true } } })
          return Response.json({})
        }
        const authorization = new Headers(init?.headers).get('authorization')
        const machineId = authorization === 'Bearer key-one' ? 'machine-one' : 'machine-two'
        if (url.pathname === '/v1/user/sync-machines') {
          const machine = {
            machineId,
            name: 'Mac',
            syncthingDeviceId: 'AAAAAAA-BBBBBBB',
            createdAt: 1,
            lastUsedAt: 1,
          }
          if (init?.method === 'POST') return Response.json(machine)
          reconciles += 1
          if (!changed) {
            changed = true
            // A foreground activation can save the new account while a daemon
            // reconcile is already in flight.
            await saveConfig(
              { apiKey: 'key-two', apiUrl: secondOrigin, machineId: 'machine-two' },
              configPath,
            )
          }
          return Response.json({
            items: [machine],
            nextCursor: null,
          })
        }
        if (url.pathname === '/v1/whoami') {
          identities.push({ url: String(input), authorization })
          return Response.json({
            user: { id: 'user', email: 'user@example.com' },
            workspaces: [
              {
                id:
                  machineId === 'machine-one' || sameWorkspaceId
                    ? 'workspace-one'
                    : 'workspace-two',
                slug: 'shared',
                name: 'Shared',
                status: 'active',
                servicingStatus: 'active',
                role: 'editor',
                billingUserId: 'user',
                funding: { plan: null, active: true },
                creditRecovery: null,
                defaultTier: { effective: 'balanced' },
              },
            ],
            scopes: ['ws:shared:files:write'],
            versions: { api: 1 },
            internalAdmin: false,
          })
        }
        const body = JSON.parse(String(init?.body))
        registrations.push({ authorization, machineId: body.machineId })
        if (body.machineId !== machineId)
          return Response.json({ error: 'not_found' }, { status: 404 })
        if (machineId === 'machine-two') {
          const firstPid = Number((await readFile(pidsPath, 'utf8')).trim().split('\n')[0])
          oldProcessStopped = !processExists(firstPid)
          oldBridgeClosed = !(await portOpen(bridgePorts[0]!))
        }
        return Response.json({
          machineId,
          folderId: 'drive',
          vmSyncthingDeviceId: 'vm',
          tunnel: { url: 'ws://127.0.0.1:1', tunnelToken: 'fixture', expiresAt: clock + 300_000 },
        })
      },
    }
    const { ctx } = await createCommandContext(['--json'], contextOptions)
    const registry = new CommandRegistry()
    registerSyncCommands(registry)
    if (foreground) {
      const args = [
        'sync',
        'run',
        'shared',
        '--once',
        ...(foreground === 'explicit' ? ['--dir', localDir] : []),
      ]
      await registry.dispatch(args, ctx)
      await saveConfig(
        { apiKey: 'key-two', apiUrl: secondOrigin, machineId: 'machine-two' },
        configPath,
      )
      const second = await createCommandContext(['--json'], contextOptions)
      await registry.dispatch(args, second.ctx)
    } else {
      await registry.dispatch(['sync', 'daemon'], ctx)
    }
    expect(identities).toEqual([
      { url: 'https://one.example/v1/whoami', authorization: 'Bearer key-one' },
      { url: `${secondOrigin}/v1/whoami`, authorization: 'Bearer key-two' },
    ])
    expect(registrations).toEqual([
      { authorization: 'Bearer key-one', machineId: 'machine-one' },
      { authorization: 'Bearer key-one', machineId: 'machine-one' },
      { authorization: 'Bearer key-two', machineId: 'machine-two' },
      { authorization: 'Bearer key-two', machineId: 'machine-two' },
    ])
    expect(oldProcessStopped).toBe(true)
    expect(oldBridgeClosed).toBe(true)
    expect(bridgePorts).toHaveLength(2)
    expect(await readFile(join(macIdentityHome(home), 'cert.pem'), 'utf8')).toBe(
      'shared-certificate',
    )
    const engineHomes = (await readFile(join(home, 'engine-homes'), 'utf8')).trim().split('\n')
    const firstFiles = await readFile(join(mirrorDirs[0]!, 'first-workspace.txt'), 'utf8')
    const firstDatabase = await readFile(join(engineHomes[0]!, 'first-workspace.db'), 'utf8')
    const secondFiles = await readFile(join(mirrorDirs[1]!, 'first-workspace.txt'), 'utf8').catch(
      () => null,
    )
    const secondDatabase = await readFile(
      join(engineHomes[1]!, 'first-workspace.db'),
      'utf8',
    ).catch(() => null)
    return { mirrorDirs, engineHomes, firstFiles, firstDatabase, secondFiles, secondDatabase }
  } finally {
    try {
      for (const pid of (await readFile(pidsPath, 'utf8')).trim().split('\n').map(Number)) {
        if (processExists(pid)) process.kill(pid, 'SIGKILL')
      }
    } catch {}
    await rm(home, { recursive: true, force: true })
  }
}

test.each([
  { label: 'different origin and workspace ID', sameOrigin: false, sameWorkspaceId: false },
  {
    label: 'different origin with the same workspace ID',
    sameOrigin: false,
    sameWorkspaceId: true,
  },
  { label: 'different workspace ID on the same origin', sameOrigin: true, sameWorkspaceId: false },
])('a daemon isolates a same-slug workspace with $label', async options => {
  const result = await runningAccountSwitch(options)
  expect(result.firstFiles).toBe('first workspace files')
  expect(result.firstDatabase).toBe('first workspace database')
  expect(result.secondFiles).toBeNull()
  expect(result.secondDatabase).toBeNull()
  expect(result.mirrorDirs[1]).not.toBe(result.mirrorDirs[0])
  expect(result.engineHomes[1]).not.toBe(result.engineHomes[0])
})

test('replacement login and machine preserve files and engine state for the same origin and durable workspace', async () => {
  const result = await runningAccountSwitch({ sameOrigin: true, sameWorkspaceId: true })
  expect(result.firstFiles).toBe('first workspace files')
  expect(result.firstDatabase).toBe('first workspace database')
  expect(result.secondFiles).toBe('first workspace files')
  expect(result.secondDatabase).toBe('first workspace database')
  expect(result.mirrorDirs[1]).toBe(result.mirrorDirs[0])
  expect(result.engineHomes[1]).toBe(result.engineHomes[0])
})

test('foreground sync defaults isolate unrelated same-slug workspace files and engine state', async () => {
  const result = await runningAccountSwitch({ foreground: 'default' })
  expect(result.firstFiles).toBe('first workspace files')
  expect(result.secondFiles).toBeNull()
  expect(result.firstDatabase).toBe('first workspace database')
  expect(result.secondDatabase).toBeNull()
})

test('an explicit foreground transfer directory is reused while unrelated workspace engine state remains isolated', async () => {
  const result = await runningAccountSwitch({ foreground: 'explicit' })
  expect(result.mirrorDirs[1]).toBe(result.mirrorDirs[0])
  expect(result.secondFiles).toBe('first workspace files')
  expect(result.secondDatabase).toBeNull()
  expect(result.engineHomes[1]).not.toBe(result.engineHomes[0])
})

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const connection = createConnection({ host: '127.0.0.1', port })
    connection.once('error', () => resolve(false))
    connection.once('connect', () => {
      connection.destroy()
      resolve(true)
    })
  })
}

test('sync run rejects conflicting workspace targets before HTTP or mirror filesystem mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-sync-target-'))
  try {
    const { ctx } = await createCommandContext(['--workspace', 'other'], {
      home,
      env: { DUET_SYNCTHING_BIN: '/missing-transfer-engine' },
      fetch: async () => {
        throw new Error('HTTP must not run')
      },
    })
    const registry = new CommandRegistry()
    registerSyncCommands(registry)
    await expect(registry.dispatch(['sync', 'run', 'acme'], ctx)).rejects.toMatchObject({
      exitCode: 64,
    })
    expect(await readdir(home)).toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sync checks local transfer support before contacting the service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-sync-prerequisite-'))
  let contacted = false
  try {
    const { ctx } = await createCommandContext([], {
      home,
      env: {
        DUET_API_KEY: 'fixture-human-key',
        DUET_API_URL: 'https://fixture.example',
        DUET_SYNCTHING_BIN: '/missing-transfer-engine',
      },
      fetch: async () => {
        contacted = true
        throw new Error('HTTP must not run without local transfer support')
      },
    })
    const registry = new CommandRegistry()
    registerSyncCommands(registry)
    await expect(registry.dispatch(['sync', 'run', 'acme'], ctx)).rejects.toThrow()
    expect(contacted).toBe(false)
    expect(await readdir(home)).toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
