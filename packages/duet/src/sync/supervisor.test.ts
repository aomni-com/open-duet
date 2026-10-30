import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DIAL_ONLY_LISTEN_ADDRESS,
  createSupervisor,
  hardenMacSyncthingConfig,
  readApiKey,
  type ManagedProcess,
} from './supervisor.js'

const generatedConfig = await readFile(
  fileURLToPath(new URL('./__fixtures__/generated-config.xml', import.meta.url)),
  'utf8',
)

const tmpDirs: string[] = []
afterAll(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-sync-'))
  tmpDirs.push(dir)
  return dir
}

describe('hardenMacSyncthingConfig', () => {
  const hardened = hardenMacSyncthingConfig(generatedConfig, { apiKey: 'MY-KEY', guiPort: 18999 })

  test('is dial-only: one empty listener, no default, no stray addresses (L24)', () => {
    const listeners = [...hardened.matchAll(/<listenAddress>([^<]*)<\/listenAddress>/g)]
    expect(listeners).toHaveLength(1)
    expect(listeners[0]![1]).toBe(DIAL_ONLY_LISTEN_ADDRESS)
    expect(hardened).not.toContain('<listenAddress>default</listenAddress>')
  })

  test('applies the full isolation set (discovery/relays/NAT/reporting/upgrade off)', () => {
    expect(hardened).toContain('<globalAnnounceEnabled>false</globalAnnounceEnabled>')
    expect(hardened).toContain('<localAnnounceEnabled>false</localAnnounceEnabled>')
    expect(hardened).toContain('<relaysEnabled>false</relaysEnabled>')
    expect(hardened).toContain('<natEnabled>false</natEnabled>')
    expect(hardened).toContain('<crashReportingEnabled>false</crashReportingEnabled>')
    expect(hardened).toContain('<urAccepted>-1</urAccepted>')
    expect(hardened).toContain('<autoUpgradeIntervalH>0</autoUpgradeIntervalH>')
    expect(hardened).toContain('<startBrowser>false</startBrowser>')
  })

  test('pins the GUI/API to loopback and sets our api key (L14)', () => {
    expect(hardened).toContain('<address>127.0.0.1:18999</address>')
    expect(readApiKey(hardened)).toBe('MY-KEY')
  })

  test('leaves the device identity and defaults untouched', () => {
    // The generated device id + its dynamic address survive (identity is stable).
    expect(hardened).toContain('EL4T4B7-ICAB7HN-ASJ6537-I2CDQBP-ZCRKIQ5-75K55V3-BYNLTMJ-NC3PXQW')
    expect(hardened).toContain('<address>dynamic</address>')
    expect(hardened).toContain('<defaults>')
  })

  test('is idempotent', () => {
    const twice = hardenMacSyncthingConfig(hardened, { apiKey: 'MY-KEY', guiPort: 18999 })
    const listeners = [...twice.matchAll(/<listenAddress>([^<]*)<\/listenAddress>/g)]
    expect(listeners).toHaveLength(1)
  })
})

describe('supervisor lifecycle', () => {
  function fakeProcess(): { proc: ManagedProcess; exit: (code: number) => void; killed: number[] } {
    let resolveExit: (code: number) => void = () => {}
    const exited = new Promise<number>(resolve => (resolveExit = resolve))
    const killed: number[] = []
    return {
      proc: {
        pid: 4242,
        kill: signal => killed.push(typeof signal === 'number' ? signal : 15),
        exited,
      },
      exit: resolveExit,
      killed,
    }
  }

  test('ensureConfig generates + hardens a fresh isolated home', async () => {
    const home = await makeHome()
    let generateCalls = 0
    const supervisor = createSupervisor({
      home,
      binaryPath: '/opt/syncthing',
      guiPort: 18991,
      generate: async (_bin, h) => {
        generateCalls += 1
        await writeFile(join(h, 'config.xml'), generatedConfig, 'utf8')
      },
      spawnProcess: () => fakeProcess().proc,
      fetch: async () => new Response('{}'),
    })
    const api = await supervisor.ensureConfig()
    expect(generateCalls).toBe(1)
    expect(api.base).toBe('http://127.0.0.1:18991')
    const written = await readFile(join(home, 'config.xml'), 'utf8')
    expect(written).toContain('<globalAnnounceEnabled>false</globalAnnounceEnabled>')
    const listeners = [...written.matchAll(/<listenAddress>([^<]*)<\/listenAddress>/g)]
    expect(listeners).toHaveLength(1)
  })

  test('workspace instances copy the Mac identity before generating independent configs', async () => {
    const identityHome = await makeHome()
    await writeFile(join(identityHome, 'cert.pem'), 'mac-cert')
    await writeFile(join(identityHome, 'key.pem'), 'mac-private-key')
    for (const guiPort of [18995, 18996]) {
      const home = await makeHome()
      const supervisor = createSupervisor({
        home,
        identityHome,
        binaryPath: '/opt/syncthing',
        guiPort,
        generate: async (_binary, workspaceHome) => {
          expect(await readFile(join(workspaceHome, 'cert.pem'), 'utf8')).toBe('mac-cert')
          expect(await readFile(join(workspaceHome, 'key.pem'), 'utf8')).toBe('mac-private-key')
          await writeFile(join(workspaceHome, 'config.xml'), generatedConfig)
        },
      })
      await supervisor.ensureConfig()
      expect(await readFile(join(home, 'config.xml'), 'utf8')).toContain(`127.0.0.1:${guiPort}`)
    }
  })

  test('restarts on crash and stops cleanly', async () => {
    const home = await makeHome()
    const processes: ReturnType<typeof fakeProcess>[] = []
    let pinged = false
    const supervisor = createSupervisor({
      home,
      binaryPath: '/opt/syncthing',
      guiPort: 18992,
      restartBackoffMs: 1,
      generate: async (_bin, h) => writeFile(join(h, 'config.xml'), generatedConfig, 'utf8'),
      spawnProcess: () => {
        const fake = fakeProcess()
        processes.push(fake)
        return fake.proc
      },
      fetch: async url => {
        if (String(url).endsWith('/rest/system/ping')) {
          pinged = true
          return new Response('{"ping":"pong"}')
        }
        return new Response('{}')
      },
      sleep: async () => {},
    })
    await supervisor.start()
    expect(pinged).toBe(true)
    expect(processes).toHaveLength(1)
    expect(supervisor.restarts()).toBe(0)

    // Crash the running instance → supervisor respawns.
    processes[0]!.exit(1)
    await Bun.sleep(20)
    expect(processes).toHaveLength(2)
    expect(supervisor.restarts()).toBe(1)

    await supervisor.stop()
    // A post-stop exit must NOT respawn.
    processes[1]!.exit(0)
    await Bun.sleep(20)
    expect(processes).toHaveLength(2)
    expect(processes[1]!.killed.length).toBeGreaterThan(0)
  })
})
