import { resolve } from 'node:path'

import { syncthingShortDeviceId, WhoamiResponseSchema } from '@repo/contract'

import {
  parseNamedOptions,
  printResult,
  resolveWorkspace,
  writeJson,
  writeText,
  type CommandContext,
  type CommandRegistry,
} from '../cli-support.js'
import { effectiveApiUrl, loadConfig } from '../config.js'
import { CliError, EXIT_CODES, usageError } from '../exit-codes.js'
import { ApiClient } from '../http.js'
import { resolveSyncthingBinary, type ResolvedSyncthing } from './binary.js'
import {
  defaultMirrorDir,
  formatStatusHuman,
  readStatusSnapshot,
  workspaceSyncKey,
  type SyncStatusSnapshot,
} from './daemon-status.js'
import { createDaemon, type DaemonSession } from './daemon.js'
import { installLaunchAgent, uninstallLaunchAgent, type LaunchdEnv } from './launchd.js'
import { registerSyncMachine } from './machine.js'
import { createRealMirrorStarter, freeLoopbackPort, type MirrorSnapshot } from './mirror.js'

// Foreground sync and the login-time daemon share one user key and Mac identity.
// Conflicts are reported for the user to resolve, never automatically rewritten.

export function registerSyncCommands(registry: CommandRegistry): void {
  registry.register('sync', sync)
}

const SYNC_USAGE = 'Usage: duet sync run|status|install|uninstall ...'

async function sync(args: string[], ctx: CommandContext): Promise<void> {
  const [subcommand, ...rest] = args
  switch (subcommand) {
    case 'run':
      return syncRun(rest, ctx)
    case 'status':
      return syncStatus(rest, ctx)
    case 'install':
      return syncInstall(rest, ctx)
    case 'uninstall':
      return syncUninstall(rest, ctx)
    case 'daemon':
      return syncDaemon(rest, ctx)
    default:
      throw usageError(SYNC_USAGE)
  }
}

async function syncRun(args: string[], ctx: CommandContext): Promise<void> {
  const parsed = parseNamedOptions(
    args.filter(arg => arg !== '--once'),
    ['gui-port', 'dir'],
  )
  const once = args.includes('--once')
  const workspace = resolveWorkspace(ctx, parsed.positionals[0])
  const resolved = await resolveSyncthingBinary({ env: ctx.env })
  const identity = WhoamiResponseSchema.parse(await (await ctx.api.request('/whoami')).json())
  const summary = identity.workspaces.find(candidate => candidate.slug === workspace)
  if (summary === undefined)
    throw new CliError('not_found', `Workspace not found: ${workspace}`, EXIT_CODES.notFound)
  const syncKey = workspaceSyncKey(
    effectiveApiUrl(ctx.config, ctx.env, ctx.global.apiUrl),
    summary.id,
  )
  const localDir =
    parsed.values.dir?.[0] ?? parsed.positionals[1] ?? defaultMirrorDir(ctx.home, syncKey)

  const guiPort = parsed.values['gui-port']?.[0]
    ? Number(parsed.values['gui-port'][0])
    : await freeLoopbackPort()

  report(ctx, `Using Syncthing ${resolved.version} (${resolved.platformKey})`)
  const machineId = await registerSyncMachine(ctx, resolved.path)
  const startMirror = createRealMirrorStarter({
    api: ctx.api,
    machineId,
    home: ctx.home,
    binaryPath: resolved.path,
    fetch: ctx.fetch,
    now: ctx.now,
    sleep: ctx.sleep,
    allocatePort: async () => guiPort,
  })
  const handle = await startMirror({
    slug: workspace,
    syncKey,
    localDir,
    log: fields => reportMirrorStart(ctx, workspace, fields),
  })
  try {
    const controller = new AbortController()
    const onSigint = (): void => controller.abort()
    process.once('SIGINT', onSigint)
    try {
      const state = await waitForMirrorConvergence(handle.poll, ctx)
      printReport(ctx, workspace, localDir, state, state.conflictPaths ?? [])
      if (once) return
      // Foreground mirror: stay up until Ctrl-C.
      report(ctx, 'Mirror live. Press Ctrl-C to stop.')
      await waitForAbort(controller.signal)
    } finally {
      process.removeListener('SIGINT', onSigint)
    }
  } finally {
    await handle.stop()
  }
}

function printReport(
  ctx: CommandContext,
  workspace: string,
  localDir: string,
  state: MirrorSnapshot,
  conflicts: string[],
): void {
  if (ctx.global.json) {
    writeJson(ctx.io.stdout, {
      ok: true,
      workspace,
      localDir,
      converged: state.converged,
      connected: state.connected,
      state: state.localState ?? 'unknown',
      needBytes: state.needBytes,
      conflicts,
    })
    return
  }
  const lines = [
    state.converged ? `Converged: ${workspace} ↔ ${localDir}` : `Not yet converged: ${workspace}`,
    `  connection: ${state.connected ? 'connected' : 'disconnected'}`,
    `  local state: ${state.localState ?? 'unknown'} (need ${state.needBytes} bytes)`,
    `  remote completion: ${state.remoteCompletion}%`,
  ]
  if (conflicts.length > 0) {
    lines.push(`  conflicts (${conflicts.length}, not auto-resolved):`)
    for (const conflict of conflicts) lines.push(`    ${conflict}`)
  }
  writeText(ctx.io.stdout, `${lines.join('\n')}\n`)
}

function formatSnapshot(state: MirrorSnapshot): string {
  return (
    `sync: ${state.connected ? 'connected' : 'connecting'} ` +
    `state=${state.localState ?? 'unknown'} need=${state.needBytes}B remote=${state.remoteCompletion}%`
  )
}

async function waitForMirrorConvergence(
  poll: () => Promise<MirrorSnapshot>,
  ctx: CommandContext,
): Promise<MirrorSnapshot> {
  const deadline = ctx.now() + 10 * 60_000
  let last = await poll()
  for (;;) {
    report(ctx, formatSnapshot(last))
    if (last.converged || ctx.now() >= deadline) return last
    await ctx.sleep(1_000)
    last = await poll()
  }
}

function reportMirrorStart(
  ctx: CommandContext,
  workspace: string,
  fields: Record<string, unknown>,
): void {
  if (fields.operation === 'mirror_local_ready' && typeof fields.localDeviceId === 'string') {
    report(
      ctx,
      `Local device ${syncthingShortDeviceId(fields.localDeviceId)} ready on 127.0.0.1:${fields.guiPort}`,
    )
  } else if (fields.operation === 'mirror_bridge_ready') {
    report(ctx, `Tunnel bridge on 127.0.0.1:${fields.port} → workspace ${workspace}`)
  } else if (fields.operation === 'mirror_configured') {
    report(ctx, `Mirroring ${fields.folderId} → ${fields.localDir}`)
  }
}

function report(ctx: CommandContext, message: string): void {
  if (!ctx.global.json) writeText(ctx.io.stderr, `${message}\n`)
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(done => signal.addEventListener('abort', () => done(), { once: true }))
}

// --- slice 22: always-on daemon --------------------------------------------

const STATUS_STALE_MS = 60_000

async function syncStatus(args: string[], ctx: CommandContext): Promise<void> {
  if (args.length > 0) throw usageError('Usage: duet sync status [--json]')
  const snapshot = await readStatusSnapshot(ctx.home)
  if (snapshot === null) {
    if (ctx.global.json) {
      writeJson(ctx.io.stdout, { ok: false, running: false, workspaces: [] })
    } else {
      writeText(
        ctx.io.stdout,
        "duet sync is not running yet. Run 'duet sync install' to start it.\n",
      )
    }
    return
  }
  if (ctx.global.json) {
    writeJson(ctx.io.stdout, { ok: true, running: true, ...snapshot })
    return
  }
  const stale = ctx.now() - snapshot.updatedAt
  if (stale > STATUS_STALE_MS) {
    writeText(
      ctx.io.stderr,
      `warning: status is ${Math.round(stale / 1000)}s old — the daemon may be stopped.\n`,
    )
  }
  writeText(ctx.io.stdout, formatStatusHuman(snapshot))
}

function launchdEnv(ctx: CommandContext): LaunchdEnv {
  return {
    home: ctx.home,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    execPath: process.execPath,
    scriptPath: resolve(process.argv[1] ?? ''),
    path: ctx.env.PATH,
  }
}

async function syncInstall(args: string[], ctx: CommandContext): Promise<void> {
  if (args.length > 0) throw usageError('Usage: duet sync install')
  // Fail fast if the transfer engine is missing — installing a daemon that
  // cannot find Syncthing is pointless. This also enforces the macOS-only + pin
  // firewalls before we touch launchd.
  const resolved = await resolveSyncthingBinary({ env: ctx.env })
  const machineId = await registerSyncMachine(ctx, resolved.path)
  const result = await installLaunchAgent(launchdEnv(ctx))
  printResult(
    ctx,
    {
      ok: true,
      machineId,
      label: result.label,
      plist: result.plistPath,
      syncthing: resolved.version,
    },
    `Installed ${result.label} (Syncthing ${resolved.version}).\n` +
      `The mirror runs at login and starts now. Check it with 'duet sync status'.\n`,
  )
}

async function syncUninstall(args: string[], ctx: CommandContext): Promise<void> {
  if (args.length > 0) throw usageError('Usage: duet sync uninstall')
  const result = await uninstallLaunchAgent(launchdEnv(ctx))
  printResult(
    ctx,
    { ok: true, label: result.label, wasLoaded: result.wasLoaded },
    result.wasLoaded
      ? `Stopped and removed ${result.label}. Your mirrored folders under ~/duet are untouched.\n`
      : `${result.label} was not installed; nothing to do.\n`,
  )
}

// The launchd entrypoint: a long-running process that mirrors each writable workspace.
// It NEVER exits on a missing login or a missing binary — it backs off and
// retries so keep-alive launchd does not thrash while the user is offline.
async function syncDaemon(args: string[], ctx: CommandContext): Promise<void> {
  if (args.length > 0) throw usageError('Usage: duet sync daemon')
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  const log = (fields: Record<string, unknown>): void =>
    writeText(
      ctx.io.stderr,
      `${JSON.stringify({ t: new Date(ctx.now()).toISOString(), ...fields })}\n`,
    )
  try {
    const resolved = await resolveBinaryWithBackoff(ctx, controller.signal, log)
    if (resolved === null) return
    const daemon = createDaemon({
      session: syncSessionLoader(ctx, resolved.path),
      home: ctx.home,
      now: ctx.now,
      sleep: ctx.sleep,
      log,
    })
    log({ operation: 'daemon_start', syncthing: resolved.version })
    await daemon.run(controller.signal)
    log({ operation: 'daemon_stopped' })
  } finally {
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
  }
}

function syncSessionLoader(
  ctx: CommandContext,
  binaryPath: string,
): () => Promise<DaemonSession | null> {
  let current: DaemonSession | undefined
  let currentIdentity: string | undefined
  return async () => {
    const config = await loadConfig(ctx.configPath)
    if (config.machineId === undefined) {
      current = undefined
      return null
    }
    const baseUrl = effectiveApiUrl(config, ctx.env, ctx.global.apiUrl)
    const apiKey = ctx.env.DUET_API_KEY ?? config.apiKey
    const identity = JSON.stringify([baseUrl, apiKey, config.machineId])
    if (current === undefined || identity !== currentIdentity) {
      const api = new ApiClient({
        baseUrl,
        apiKey,
        fetch: ctx.fetch,
      })
      current = {
        api,
        apiOrigin: baseUrl,
        machineId: config.machineId,
        startMirror: createRealMirrorStarter({
          api,
          machineId: config.machineId,
          home: ctx.home,
          binaryPath,
          fetch: ctx.fetch,
          now: ctx.now,
          sleep: ctx.sleep,
        }),
      }
      currentIdentity = identity
    }
    return current
  }
}

async function resolveBinaryWithBackoff(
  ctx: CommandContext,
  signal: AbortSignal,
  log: (fields: Record<string, unknown>) => void,
): Promise<ResolvedSyncthing | null> {
  let backoff = 5_000
  while (!signal.aborted) {
    try {
      return await resolveSyncthingBinary({ env: ctx.env })
    } catch (error) {
      log({
        operation: 'syncthing_unavailable',
        error: error instanceof Error ? error.message : String(error),
        retryInMs: backoff,
      })
      await ctx.sleep(backoff)
      backoff = Math.min(backoff * 2, 5 * 60_000)
    }
  }
  return null
}

export type { SyncStatusSnapshot }
