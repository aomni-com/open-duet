import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { copyMacIdentity, prepareMacIdentity } from './machine.js'
import { ping, systemStatus, type FetchLike, type SyncthingApi } from './syncthing-api.js'

// Runs stock Syncthing headless under an ISOLATED home (spec file-attribution
// slice 21, MAP-SYNC L24/L14/V2). Never the user's own ~/Library Syncthing —
// its own home, identity, DB, and loopback API key. Two hard rules the harden
// step enforces before the FIRST listen:
//   - dial-only: the listener list is emptied (L24) — this instance only ever
//     dials the loopback tunnel bridge; it never accepts an inbound BEP dial.
//   - loopback + quiet: discovery/relays/NAT/crash+usage reporting off, no
//     auto-upgrade (STNOUPGRADE pins the binary too), GUI/API on loopback (L14).
// The gateway hardens the same set on the VM; this is the Mac mirror of it,
// minus a listener.

/** The one empty listen entry that makes Syncthing dial-only (verified: yields
 * only the GUI listener, no BEP listener — MAP-SYNC L24). */
export const DIAL_ONLY_LISTEN_ADDRESS = ''

export interface ManagedProcess {
  readonly pid: number | undefined
  kill(signal?: NodeJS.Signals | number): void
  readonly exited: Promise<number>
}

export interface SupervisorOptions {
  /** Isolated Syncthing home, e.g. ~/.duet/sync. */
  home: string
  /** Shared Mac certificate/private key; each workspace still has its own config and DB. */
  identityHome?: string
  /** Verified Syncthing binary path (from resolveSyncthingBinary). */
  binaryPath: string
  /** Loopback GUI/API port. Distinct from 8384 so a user's Syncthing is untouched. */
  guiPort: number
  fetch?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Spawn `syncthing generate` and `syncthing serve`. Injected in tests. */
  spawnProcess?: (argv: string[], env: Record<string, string>) => ManagedProcess
  /** Run `syncthing generate` to first-init a fresh home. Injected in tests. */
  generate?: (binaryPath: string, home: string) => Promise<void>
  restartBackoffMs?: number
  readyTimeoutMs?: number
  log?: (fields: Record<string, unknown>) => void
}

export interface Supervisor {
  /** Ensure a hardened isolated config exists; returns the loopback API. */
  ensureConfig(): Promise<SyncthingApi>
  start(): Promise<SyncthingApi>
  waitUntilReady(): Promise<void>
  deviceId(): Promise<string>
  restarts(): number
  stop(): Promise<void>
  api(): SyncthingApi
}

const DEFAULT_RESTART_BACKOFF_MS = 1_000
const DEFAULT_READY_TIMEOUT_MS = 30_000

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms).unref?.()))
  const spawnProcess = options.spawnProcess ?? defaultSpawn
  const generate = options.generate ?? defaultGenerate
  const restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const configPath = join(options.home, 'config.xml')

  let apiKey: string | null = null
  let desired = false
  let restartCount = 0
  let current: ManagedProcess | null = null

  function api(): SyncthingApi {
    if (apiKey === null) throw new Error('Supervisor config not initialized')
    return { base: `http://127.0.0.1:${options.guiPort}`, apiKey, fetch: fetchImpl }
  }

  async function ensureConfig(): Promise<SyncthingApi> {
    await mkdir(options.home, { recursive: true, mode: 0o700 })
    if (options.identityHome !== undefined) {
      await prepareMacIdentity(options.binaryPath, options.identityHome)
      await copyMacIdentity(options.identityHome, options.home)
    }
    let xml = await readConfigXml(configPath)
    if (xml === null) {
      await generate(options.binaryPath, options.home)
      xml = await readConfigXml(configPath)
      if (xml === null) throw new Error('Syncthing generate did not write a config')
    }
    // Keep an existing key (stable identity across runs); mint one only if the
    // fresh config somehow lacks it.
    const existingKey = readApiKey(xml)
    apiKey = existingKey ?? randomBytes(24).toString('base64url')
    const hardened = hardenMacSyncthingConfig(xml, { apiKey, guiPort: options.guiPort })
    await writeFile(configPath, hardened, 'utf8')
    return api()
  }

  async function start(): Promise<SyncthingApi> {
    if (apiKey === null) await ensureConfig()
    desired = true
    spawnServe()
    await waitUntilReady()
    return api()
  }

  function spawnServe(): void {
    const proc = spawnProcess(
      [options.binaryPath, 'serve', '--no-browser', '--no-restart', `--home=${options.home}`],
      { STNOUPGRADE: '1', STNODEFAULTFOLDER: '1' },
    )
    current = proc
    void proc.exited.then(code => {
      if (!desired || current !== proc) return
      restartCount += 1
      options.log?.({ operation: 'syncthing_exit', code, restart: restartCount })
      void sleep(restartBackoffMs).then(() => {
        if (desired) spawnServe()
      })
    })
  }

  async function waitUntilReady(): Promise<void> {
    const deadline = now() + readyTimeoutMs
    while (now() < deadline) {
      if (await ping(api())) return
      await sleep(200)
    }
    throw new Error(`Syncthing did not become ready within ${readyTimeoutMs}ms`)
  }

  async function deviceId(): Promise<string> {
    const status = await systemStatus(api())
    if (typeof status.myID !== 'string' || status.myID.length === 0) {
      throw new Error('Syncthing did not report a device ID')
    }
    return status.myID
  }

  async function stop(): Promise<void> {
    desired = false
    const proc = current
    current = null
    if (proc === null) return
    proc.kill('SIGTERM')
    await Promise.race([proc.exited, sleep(2_000)])
    proc.kill('SIGKILL')
  }

  return {
    ensureConfig,
    start,
    waitUntilReady,
    deviceId,
    restarts: () => restartCount,
    stop,
    api,
  }
}

/**
 * Pure, idempotent hardening of a `syncthing generate` config.xml for the
 * dial-only Mac instance. Only the `<options>` and `<gui>` blocks are touched —
 * `<device>`, `<folder>`, and `<defaults>` are left exactly as they are, so
 * re-running over a config that already carries the mirror device/folder is a
 * no-op on that state.
 */
export function hardenMacSyncthingConfig(
  xml: string,
  input: { apiKey: string; guiPort: number },
): string {
  let out = editBlock(xml, 'options', block => {
    let options = block
    for (const [name, value] of HARDENED_OPTIONS) {
      options = setChildText(options, name, value)
    }
    // Dial-only: drop every listenAddress, then one empty entry (L24).
    options = options.replace(/\s*<listenAddress>[^<]*<\/listenAddress>/g, '')
    options = insertBefore(
      options,
      '</options>',
      `    <listenAddress>${DIAL_ONLY_LISTEN_ADDRESS}</listenAddress>\n`,
    )
    return options
  })
  out = editBlock(out, 'gui', block => {
    let gui = setChildText(block, 'address', `127.0.0.1:${input.guiPort}`)
    gui = setChildText(gui, 'apikey', input.apiKey)
    return gui
  })
  return out
}

const HARDENED_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['globalAnnounceEnabled', 'false'],
  ['localAnnounceEnabled', 'false'],
  ['relaysEnabled', 'false'],
  ['natEnabled', 'false'],
  ['crashReportingEnabled', 'false'],
  ['urAccepted', '-1'],
  ['autoUpgradeIntervalH', '0'],
  ['startBrowser', 'false'],
]

function editBlock(xml: string, tag: string, edit: (block: string) => string): string {
  const pattern = new RegExp(`(<${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${tag}>)`)
  const match = xml.match(pattern)
  if (match === null) return xml
  return xml.replace(pattern, `${match[1]}${edit(match[2]!)}${match[3]}`)
}

function setChildText(block: string, tag: string, value: string): string {
  const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`)
  if (pattern.test(block)) return block.replace(pattern, `<${tag}>${value}</${tag}>`)
  return insertBefore(block, `</`, `    <${tag}>${value}</${tag}>\n`)
}

function insertBefore(haystack: string, needle: string, insertion: string): string {
  const index = haystack.lastIndexOf(needle)
  if (index === -1) return `${haystack}${insertion}`
  return `${haystack.slice(0, index)}${insertion}${haystack.slice(index)}`
}

export function readApiKey(xml: string): string | null {
  return xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1]?.trim() ?? null
}

async function readConfigXml(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function defaultSpawn(argv: string[], env: Record<string, string>): ManagedProcess {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return {
    get pid() {
      return proc.pid
    },
    kill(signal) {
      try {
        proc.kill(signal as number | undefined)
      } catch {
        // already gone
      }
    },
    exited: proc.exited,
  }
}

async function defaultGenerate(binaryPath: string, home: string): Promise<void> {
  const proc = Bun.spawn([binaryPath, 'generate', `--home=${home}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`syncthing generate exited with ${code}`)
}
