import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import { Hono } from 'hono'

import {
  DESKTOP_CDP_PORT,
  DUET_ACTOR_CONTEXT_HEADER,
  encodeActorContext,
  assertPathOutsideDriveRoot,
  extractBearerToken,
  GatewayAnchorsReconcileRequestSchema,
  GatewaySessionIntegrationsRefreshResponseSchema,
  MAX_TRAIN_FILES,
  TRAIN_UPLOADS_CAP_BYTES,
  VmDesiredMarketplaceAgentsSchema,
  VmSyncResponseSchema,
  gatewayAgentCandidate,
  resolveNearestAgent,
  type AnchorMoveCandidatesReport,
  type GatewayAppConfig,
  type GatewayAnchor,
  type GatewayRunnerInputRequest,
  type GatewaySessionIntegrationsRefreshResponse,
  type McpServersConfig,
  DESKTOP_CHROME_PROFILE_IN_STATE,
  DESKTOP_DISPLAY,
  desktopCredentialPathForRequest,
  normalizeDrivePath,
  normalizeDriveUrlPath,
} from '@repo/contract'

import { createIntegrationsHandshakeWarmer } from '../agent-sessions/integrations-handshake'
import { buildMcpServersConfig, integrationsProxyTarget } from '../agent-sessions/mcp-servers'
import { ensureAgentMemoryStores } from '../agents/agent-folder'
import { createAgentRoster } from '../agents/agent-roster'
import { createAnchorRegistry } from '../agents/anchor-registry'
import { createMemoryWarmupRail } from '../agents/memory-warmup'
import { createAppCredentialStore } from '../app-credentials'
import { createActorResolver } from '../attribution/actor-resolver'
import { createHelperOverflowWatch } from '../attribution/helper-overflow-watch'
import {
  createHelperSupervisor,
  spawnHelperProcess,
  type HelperSupervisor,
} from '../attribution/helper-supervisor'
import { createFileEventPipeline, type FileEventPipeline } from '../attribution/pipeline'
import { createScanNudge, mountStoreScanTargets } from '../attribution/scan-nudge'
import { createSyncthingEventConsumer, mountStoreRegistry } from '../attribution/syncthing-events'
import { DriveGrants, InvalidDriveGrantError } from '../auth/drive-grants'
import { createUploadCorsPolicy } from '../auth/upload-cors'
import {
  ROOT_UPLOAD_SCOPE,
  trainUploadsPath,
  uploadScopeForPath,
  type UploadScope,
} from '../auth/upload-scope'
import { UploadTokenCredential } from '../auth/upload-token'
import { createBackupRoutes } from '../backups/routes'
import { createBackupWorker } from '../backups/worker'
import { createBootHealth } from '../boot-health'
import { createConnectSessionManager } from '../connected-providers/connect-session'
import { createDesiredStateStore, type DesiredStateStore } from '../desired-state'
import { discoverBrowserGeneration, discoverBrowserWebSocket } from '../desktop/browser'
import { createBrowserBatchService } from '../desktop/browser-batches'
import { createBrowserWindowLedgerStore } from '../desktop/browser-ledger'
import {
  createBrowserReconciliationTrigger,
  createDesktopBrowserManager,
  type DesktopBrowserManager,
} from '../desktop/browser-manager'
import { reapBrowserMetrics } from '../desktop/browser-metrics'
import {
  createCdpGrantRegistry,
  desktopCdpWebSocketHandlers,
  handleDesktopCdpUpgrade,
  type DesktopCdpSocketData,
} from '../desktop/cdp-proxy'
import { createChromeUpdater } from '../desktop/chrome-update'
import { clearStaleDisplayLock } from '../desktop/display-lock'
import {
  BrowserExtensionBridge,
  browserExtensionWebSocketHandlers,
  handleBrowserExtensionUpgrade,
  type BrowserExtensionSocketData,
} from '../desktop/extension-bridge'
import {
  createDesktopSupervisor,
  DESKTOP_TICK_MS,
  type DesktopSupervisor,
} from '../desktop/supervisor'
import { createGatewayLogger } from '../gateway-logger'
import { inspectListableAgent } from '../marketplace/inspector'
import { createMarketplaceAgentPuller } from '../marketplace/puller'
import { createMemoryReflectRail } from '../memory-reflect'
import { createModelCredentialStore } from '../model-credentials'
import { createAgentRosterRoutes } from '../routes/agent-roster'
import { createAgentSessionsRoutes } from '../routes/agentSessions'
import { createAnchorReconciler, type AnchorReconcileTelemetry } from '../routes/anchors'
import { createAppsRoutes } from '../routes/apps'
import { createConnectedProvidersRoutes } from '../routes/connected-providers'
import {
  createDesktopIngress,
  desktopWebSocketHandlers,
  handleDesktopUpgrade,
  readKasmCredentialFile,
  type DesktopSocketData,
} from '../routes/desktop'
import { createFilesRoutes, type FilesRouteVariables } from '../routes/files'
import { sweepDriveUploadTemps } from '../routes/files-temp'
import { createInternalAdminRoutes } from '../routes/internalAdmin'
import { createMemoryRoutes } from '../routes/memory'
import { createPublishesControlRoutes, createPublishesRoutes } from '../routes/publishes'
import { createSkillsRoutes } from '../routes/skills'
import { createSyncRoutes } from '../routes/sync'
import { createTrainUploadsRoutes } from '../routes/train-uploads'
import {
  createMirrorTunnelRoutes,
  createTunnelAcceptRegistry,
  handleTunnelUpgrade,
  tunnelWebSocketHandlers,
  type TunnelAcceptRegistry,
  type TunnelSocketData,
} from '../routes/tunnel'
import { ensureRunnerCgroup, sweepStaleRunnerLeaves } from '../runner/cgroup'
import { sweepOrphanRunners } from '../runner/orphan-sweep'
import { createRuntimeUpdater } from '../runtime-update'
import { createSkillsInstallGate, installSkills } from '../skills-install'
import { SyncBridgeRegistry } from '../sync/bridge-registry'
import { ensureReadMountsWritable } from '../sync/mounts'
import { createReadModeEnforcer } from '../sync/read-mode-enforcer'
import { reconcileMirrorMachineAccess, reconcileSyncthingFromStore } from '../sync/reconcile'
import { createShareConverger } from '../sync/share-converger'
import {
  createSyncthingConfigCoordinator,
  readSyncthingDeviceId,
  reconcileSyncthingHardening,
  syncthingConnection,
} from '../sync/syncthing-client'
import { runSystemCommand } from '../system-command'
import { createTrainRoutes } from '../train-runner'
import {
  resolveTrainScope,
  TrainScopeResolutionError,
  trainScopeErrorResponse,
  type TrainScope,
} from '../train/agent-scope'
import { createTrainJobLedger } from '../train/job-ledger'
import { createTrainRecordIndexCoordinator } from '../train/record-index-coordinator'
import { createUploadsStore } from '../train/uploads-store'
import { completePendingRestore, type RestoreSuppression } from '../vm/archive'
import { createDiskGuard } from '../vm/disk-guard'
import { createVmPhoneHome, readVmToken, type RegisterResponse } from '../vm/phone-home'
import { createRestoreWindow } from '../vm/restore-window'
import { createVmSyncClient, type SyncDirectiveSink } from '../vm/sync-client'
import { readProcessBootId } from './boot-identity'
import { normalizeEnv, parseExtraHeaders, type GatewayEnv } from './env'
import { RUNNING_RUNTIME } from './paths'
import { installProcessGuards } from './process-guards'
import { gatewayServeLimits } from './serve-limits'
import {
  createWebSocketRouter,
  runWebSocketUpgradeHandlers,
  type WebSocketUpgradeHandler,
} from './ws-router'

export {
  DEFAULT_CURRENT_RELEASE_LINK,
  DEFAULT_RUNTIME_UPDATE_MAX_DEFER_MS,
  DEFAULT_RELEASES_DIR,
} from '../runtime-update'

export const GATEWAY_AUTH_ALLOWLIST = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/v1/desktop/browser-extension/update.xml' },
  { method: 'GET', path: '/v1/desktop/browser-extension/extension.crx' },
] as const

export type GatewaySocketData =
  | TunnelSocketData
  | DesktopSocketData
  | BrowserExtensionSocketData
  | DesktopCdpSocketData

const SYNCTHING_INTEGRATION_RETRY = { baseMs: 1_000, maxMs: 30_000 }

// How often to log the attribution counter gauges — the retention soak's data
// source (MAP Q11, L12 telemetry). A scraper diffs successive lines for volume.
const ATTRIBUTION_STATS_LOG_MS = 300_000

export interface GatewayRuntime {
  app: Hono<{ Variables: FilesRouteVariables }>
  /** Once per process, by the real entry point only: see `process-guards.ts`. */
  installProcessGuards(): void
  startSyncLoop(): void
  /**
   * Starts Syncthing consumers only after the loopback config is hardened and
   * the durable mount registry has been projected; retries the whole
   * initialization lifecycle until both phases succeed.
   */
  startSyncthingIntegrationLoop(): void
  /**
   * Brings the privileged fanotify helper live (spec file-attribution slice 11):
   * spawns + supervises it, wiring every `fs` frame through the actor resolver
   * into the one pipeline, and refreshes the Syncthing pid the helper drops.
   * Started only from the production entry (needs sudo + fanotify); never in
   * tests, which drive the runtime without a kernel watcher.
   */
  startHelperLoop(): void
  /** Starts the gateway-local desktop lifecycle loop. Production only. */
  startDesktopLoop(): void
  /**
   * Starts the nightly memory reflection pass — one per agent, because each
   * agent remembers into its own database.
   */
  startMemoryReflectLoop(): void
  registerOnce(): Promise<RegisterResponse>
  syncOnce(): Promise<void>
  getVmToken(): Promise<string | null>
  routeSpecs(): Array<{ method: string; path: string }>
  desiredState: DesiredStateStore
  tunnelAccepts: TunnelAcceptRegistry
  tunnelWebSocket: Bun.WebSocketHandler<TunnelSocketData>
  desktop: ReturnType<typeof createDesktopIngress>
  browserExtension: BrowserExtensionBridge
  browserManager: DesktopBrowserManager
  browserCdpGrants: ReturnType<typeof createCdpGrantRegistry>
  desktopSupervisor: DesktopSupervisor
  /** The one file-event pipeline (spec file-attribution slice 04). */
  fileEvents: FileEventPipeline
  /**
   * The Bun server that will end up serving `app` doesn't exist yet at
   * runtime-construction time — only the entry point that calls `Bun.serve`
   * knows it. Wires the real `server.timeout()` in once that server starts.
   * Agent `/input` receives a bounded extension for its slow unary wait; Drive
   * PUT disables the timeout while its body streams.
   */
  setRequestTimeoutExtender(extender: (request: Request, seconds: number) => void): void
}

export function createGatewayRuntime(env: GatewayEnv = {}): GatewayRuntime {
  const config = normalizeEnv(env)
  const bootId = readProcessBootId()
  const instanceId = env.instanceId ?? randomUUID()
  const diskGuard = createDiskGuard({
    driveMount: config.driveDir,
    now: config.now,
  })
  sweepOrphanRunners()
  const runnerCgroupReady = ensureRunnerCgroup()
  const app = new Hono<{ Variables: FilesRouteVariables }>()
  const startedAt = config.now()
  const logger = createGatewayLogger(config.stateDir)
  const tunnelWebSocket = tunnelWebSocketHandlers({
    log: fields => logger.log('tunnel', fields),
  })
  const connectedProviders = createConnectSessionManager({
    runCommand: config.connectedProviderRunCommand,
    now: config.now,
  })
  const modelCredentials = createModelCredentialStore(config.stateDir)
  const appCredentials = createAppCredentialStore(config.stateDir)
  const desiredState = createDesiredStateStore(config.stateDir)
  const bootHealth = createBootHealth({ stateDir: config.stateDir, now: config.now })
  const trainJobs = createTrainJobLedger({
    stateDir: config.stateDir,
    now: config.now,
    wakeSync: () => syncClient.wake(),
  })
  const trainStateDir = assertPathOutsideDriveRoot(
    resolve(config.stateDir, 'train'),
    config.driveDir,
  )
  const uploadsStores = createUploadsStore({
    trainDir: trainStateDir,
    capBytes: TRAIN_UPLOADS_CAP_BYTES,
    maxFiles: MAX_TRAIN_FILES,
  })
  const uploadsReady = uploadsStores.sweepTemp()
  // Runtime construction is synchronous, while the boot sweep is not. Keep
  // the original promise for routes to observe, and attach a handler so a
  // runtime that never serves an upload request cannot leak a rejection.
  void uploadsReady.catch(() => undefined)
  const uploadTokens = new UploadTokenCredential(config.stateDir)
  const driveGrants = new DriveGrants(config.stateDir)
  const driveUploadTempDir = resolve(config.driveDir, '.duet', 'uploads')
  const driveUploadsReady = sweepDriveUploadTemps(driveUploadTempDir, error =>
    logger.log('files', {
      operation: 'stale_upload_sweep_failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  let vmTokenMemory: string | null = null
  let maintenanceBlocksStarts = false
  const backupWorker = createBackupWorker({
    isStartBlocked: () => maintenanceBlocksStarts,
    driveDir: config.driveDir,
    stateDir: config.stateDir,
    apiUrl: config.apiUrl,
    getVmToken,
    fetch: config.fetch,
    extraHeaders: config.extraHeaders,
    now: config.now,
    log: fields => logger.log('backup', fields),
    wakeSync: () => syncClient.wake(),
  })
  let loggedMissingModelCredentials = false
  let updateCycle: Promise<void> | null = null
  let updateRequested = false
  const restoreWindow = createRestoreWindow()
  let latestAnchorReconcile: AnchorReconcileTelemetry | null = null
  const anchorReconciler = createAnchorReconciler({
    driveDir: config.driveDir,
    stateDir: config.stateDir,
    reportMoveCandidates,
    restoreInFlight: restoreWindow.inFlight,
    // Loud on purpose: a skipped cycle means anchor reconciliation is blind, and
    // a blind rail that says nothing looks exactly like a healthy one.
    onReconcileSkipped: reason =>
      logger.log('anchors', {
        operation: 'reconcile_skipped',
        status: 'skipped',
        reason,
        driveDir: config.driveDir,
      }),
    onReconcileTelemetry: event => {
      latestAnchorReconcile = event
      logger.log('anchors', {
        operation: 'reconcile',
        ...event,
      })
    },
  })
  const trainRecordIndexes = createTrainRecordIndexCoordinator({
    driveDir: config.driveDir,
    stateDir: config.stateDir,
    onRecordSkipped: event => logger.log('train', { operation: 'record_skipped', ...event }),
    onError: error =>
      logger.log('train', {
        operation: 'record_index_reconcile_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
  })
  function trainScopes(anchors: readonly GatewayAnchor[]) {
    return [
      resolveTrainScope({ anchors, driveDir: config.driveDir, stateDir: config.stateDir }),
      ...anchors
        .filter(anchor => anchor.agentId !== undefined)
        .flatMap(anchor => {
          try {
            return [
              resolveTrainScope({
                anchorId: anchor.id,
                anchors,
                driveDir: config.driveDir,
                stateDir: config.stateDir,
              }),
            ]
          } catch {
            return []
          }
        }),
    ]
  }
  const memoryWarmup = createMemoryWarmupRail({
    stateDir: config.stateDir,
    memoryDbPath: config.memoryDbPath,
    busy: () => hasActiveRunners(),
    runner: config.duetRunner,
    log: fields => logger.log('memory-warmup', fields),
  })
  const anchorRegistry = createAnchorRegistry({
    reconcileMarkers: async anchors => {
      const reports = await anchorReconciler.reconcile(anchors)
      // After the reconcile, not inside it: owning a memory store is a property
      // of being a registered agent, but it is not evidence the reconcile reads,
      // and its algorithm stays about anchors alone.
      ensureAgentMemoryStores(config.driveDir, anchors)
      // Off the sync cycle entirely: a store build is seconds of CPU, and the
      // cycle that registered the agent must not wait on it. Its outcome is
      // logged, and a build that never happens only costs the first turn.
      void memoryWarmup.warm(anchors)
      // The record index feeds the train tab; it is not anchor state. Its
      // failure is already logged by the coordinator and must not fail the
      // sync cycle — a failed cycle marks the workspace unhealthy and takes
      // the Files pane and every app down with it.
      await trainRecordIndexes.syncScopes(trainScopes(anchors)).catch(() => undefined)
      return reports
    },
  })
  const recordIndexesReady = trainRecordIndexes.syncScopes(trainScopes(anchorRegistry.snapshot()))
  // Observed here so a first build that fails is not an unhandled rejection at
  // boot; the train runner still sees the failure when it awaits readiness.
  recordIndexesReady.catch(() => undefined)
  const agentRoster = createAgentRoster()
  // One pipeline for every semantic file event the gateway emits; the files
  // and publish routes get its emitter injected below (MAP Q5/Q6).
  const fileEvents = createFileEventPipeline({
    apiUrl: config.apiUrl,
    getVmToken,
    fetch: config.fetch,
    now: config.now,
    extraHeaders: config.extraHeaders,
    onQueueLimit: event =>
      logger.log('file-events', { event: 'file_event_queue_limit_reached', ...event }),
  })
  fileEvents.onEvent(trainRecordIndexes.onFileEvent)
  // The one OS-event → actor policy owner (slice 11). Actor context is the
  // identity carrier; gatewayPid is a defensive second drop behind the helper's.
  const actorResolver = createActorResolver({ gatewayPid: process.pid })
  // The privileged helper's gateway supervisor (slice 10) — created here, but
  // only spawned by startHelperLoop() (production only). Its `fs` frames flow
  // through the resolver into the pipeline; its `stats` (and restart count) fold
  // into the pipeline's one telemetry surface (L12).
  let helperLoopStarted = false
  const trainHelperOverflow = createHelperOverflowWatch(() => {
    trainRecordIndexes.onFileEventLoss()
    void trainRecordIndexes.recoverFileEventLoss()
  })
  const helperSupervisor: HelperSupervisor = createHelperSupervisor({
    helperPath: RUNNING_RUNTIME.helper,
    driveDir: config.driveDir,
    spawn: config.helperSpawn ?? spawnHelperProcess,
    gatewayPid: process.pid,
    onEvent: event => {
      if (event.t === 'fs') {
        const resolved = actorResolver.resolve(event)
        if (resolved !== null) fileEvents.emit(resolved)
      } else if (event.t === 'stats') {
        trainHelperOverflow.observe(event.overflow)
        fileEvents.mergeHelperStats({
          overflow: event.overflow,
          cgroupMisses: event.cgroupMisses,
          helperRestarts: helperSupervisor.stats().helperRestarts,
        })
      }
    },
    onReady: () => {
      trainHelperOverflow.reset()
      return trainRecordIndexes.recoverFileEventLoss()
    },
    onDown: () => {
      trainRecordIndexes.onFileEventLoss()
      fileEvents.mergeHelperStats({ helperRestarts: helperSupervisor.stats().helperRestarts })
    },
    log: fields => logger.log('helper', fields),
  })
  // Restore-time suppression seam (L6): mute the pipeline AND the helper around
  // the destructive swap, then emit exactly one `system` restore event once
  // suppression lifts. Wired into phone-home's restore path below.
  const restoreSuppression: RestoreSuppression = {
    begin: () => {
      fileEvents.suppress(true)
      helperSupervisor.suppress(true)
    },
    end: () => {
      fileEvents.suppress(false)
      helperSupervisor.suppress(false)
    },
    emitOne: () =>
      fileEvents.emit({
        kind: 'restore',
        actor: encodeActorContext({ kind: 'system' }),
        at: config.now(),
      }),
  }
  // Both Syncthing directions use the one loopback client: inbound disk-event
  // translation and the outbound scan nudge fed by its onEvent tap. Consumers
  // remain idle until the complete initialization lifecycle succeeds.
  const syncthingClientOptions = {
    stateDir: config.stateDir,
    syncthingApiUrl: config.syncthingApiUrl,
    syncthingApiKey: config.syncthingApiKey,
  }
  const tunnelAccepts = createTunnelAcceptRegistry({ now: config.now })
  const syncthingConfig = createSyncthingConfigCoordinator(syncthingClientOptions, config.fetch)
  const shareConverger = createShareConverger({
    ...syncthingClientOptions,
    driveDir: config.driveDir,
    fetch: config.fetch,
    accepts: tunnelAccepts,
    bridges: new SyncBridgeRegistry({ log: fields => logger.log('tunnel', fields) }),
    configCoordinator: syncthingConfig,
  })
  const syncthingEvents = createSyncthingEventConsumer({
    connection: () => syncthingConnection(syncthingClientOptions),
    fetch: config.fetch,
    now: config.now,
    emit: fileEvents.emit,
    resolveRegistry: mountStoreRegistry(config.stateDir),
    log: fields => logger.log('syncthing-events', fields),
  })
  const readModeEnforcer = createReadModeEnforcer({
    stateDir: config.stateDir,
    driveDir: config.driveDir,
    connection: () => syncthingConnection(syncthingClientOptions),
    fetch: config.fetch,
    log: fields => logger.log('read-mode-enforcer', fields),
  })
  const scanNudge = createScanNudge({
    connection: () => syncthingConnection(syncthingClientOptions),
    fetch: config.fetch,
    resolveTargets: mountStoreScanTargets(config.stateDir),
    log: fields => logger.log('scan-nudge', fields),
  })
  let syncthingIntegrationStarted = false
  const normalizedApiUrl = config.apiUrl?.replace(/\/+$/, '')
  // Every app gets the address; the key stays its own. The model gateway is what
  // decides who may spend — it refuses a key without `services` — so filtering
  // here would only be a second copy of that rule, drifting from the first.
  /**
   * Where the app is, and whose folder it is in — both drive-relative, both
   * resolved here because the gateway is the only side that knows. An app that
   * assumes its own location is right for exactly one workspace: the one whose
   * folders happen to match the manifest. An installed copy is named by whoever
   * installed it.
   *
   * `DUET_AGENT_DIR` is absent for an app that sits at the workspace root, and
   * absent until the roster has arrived — an app must treat absence as "not
   * ready" and refuse to write, never as a default. A folder move changes the
   * app's own `anchorPath`, which is part of its runtime config, so the
   * supervisor restarts it with fresh values rather than leaving it stale.
   */
  const appLocationEnv = (
    app: GatewayAppConfig,
  ): { DUET_APP_DIR: string; DUET_AGENT_DIR?: string } => {
    const roster = agentRoster.snapshot() ?? []
    const owner = resolveNearestAgent(
      app.anchorPath,
      roster.flatMap(row => (row.kind === 'agent' ? [gatewayAgentCandidate(row)] : [])),
    )
    return {
      DUET_APP_DIR: app.anchorPath,
      ...(owner === null ? {} : { DUET_AGENT_DIR: owner.rootPath }),
    }
  }

  const gatewayBaseUrlEnv = (): { DUET_GATEWAY_BASE_URL?: string } => {
    const url = modelCredentials.currentModelEnv(config.now())?.DUET_GATEWAY_BASE_URL
    return url === undefined ? {} : { DUET_GATEWAY_BASE_URL: url }
  }
  const appsRoutes = createAppsRoutes({
    driveDir: config.driveDir,
    spawnEnvExtras: app => ({
      ...appCredentials.envForApp(app.appId),
      ...(normalizedApiUrl === undefined ? {} : { DUET_API_URL: normalizedApiUrl }),
      // The model gateway's ADDRESS, never the workspace model key beside it.
      // An app pays for its own generations: preflight has a `kind === 'app'`
      // branch that attributes the spend to the app, so handing over the
      // runner's workspace-wide key would over-grant for no gain.
      ...gatewayBaseUrlEnv(),
      ...appLocationEnv(app),
    }),
  })
  appCredentials.onChange(appId => appsRoutes.supervisor.restartApp(appId))
  const marketplacePuller = createMarketplaceAgentPuller({
    stateDir: config.stateDir,
    driveDir: config.driveDir,
    fetch: config.fetch,
    now: config.now,
    postApply: async applied => {
      const requiredReadySlugs: string[] = []
      const nextApps = appsRoutes.supervisor.desiredConfigs().map(app => {
        if (app.anchorPath !== applied.path && !app.anchorPath.startsWith(`${applied.path}/`)) {
          return app
        }
        requiredReadySlugs.push(app.slug)
        return { ...app, contentGeneration: applied.etag }
      })
      if (requiredReadySlugs.length === 0) return
      await appsRoutes.supervisor.reconcile(nextApps, { requiredReadySlugs })
    },
    log: fields => logger.log('marketplace', fields),
  })
  // Filled in by setRequestTimeoutExtender once the real Bun server exists;
  // see the interface doc on GatewayRuntime for why the indirection.
  let requestTimeoutExtender: ((request: Request, seconds: number) => void) | undefined
  let discardBrowserOwner: ((agentAnchorId: string) => Promise<void>) | undefined
  const waitsForDefaultSkills = shouldEnsureAgentRunner(env)
  const skillsInstallGate = createSkillsInstallGate({ waitForFirstTrack: waitsForDefaultSkills })
  // Where a runner on this VM reaches this gateway: the port the entry point
  // serves on, which it passes in because the runtime is built before the
  // server exists.
  const localGatewayBaseUrl = `http://127.0.0.1:${env.port ?? 3000}`
  const integrationsHandshake = createIntegrationsHandshakeWarmer({
    fetch: config.fetch,
    now: config.now,
    log: fields => logger.log('agent-sessions', fields),
  })
  const integrationsMcp = {
    answer: integrationsHandshake.answer,
    upstream: integrationsUpstream,
    fetch: config.fetch,
  }
  const agentSessions = createAgentSessionsRoutes({
    log: fields => logger.log('agent-sessions', fields),
    extendTimeout: (request, seconds) => requestTimeoutExtender?.(request, seconds),
    apiUrl: config.apiUrl,
    stateDir: config.stateDir,
    driveDir: config.driveDir,
    memoryDbPath: config.memoryDbPath,
    anchors: anchorRegistry.snapshot,
    apps: () => appsRoutes.supervisor.desiredConfigs(),
    agents: () => agentRoster.snapshot(),
    workspaceSlug: () => desiredState.current().workspaceSlug,
    getVmToken,
    fetch: config.fetch,
    runnerFactory: env.agentRunnerFactory,
    relayEvent: env.agentRelayEvent,
    modelEnv: modelEnvForSpawn,
    mcpServers: mcpServersForSpawn,
    refreshTurnMcp: refreshTurnMcpForWake,
    integrationsMcp,
    ensureRunner: skillsInstallGate.wait,
    isQuiesced: () => desiredState.current().quiesced,
    diskGuard,
    discardBrowserOwner: agentAnchorId => discardBrowserOwner?.(agentAnchorId) ?? Promise.resolve(),
  })
  // Set before the constructor's asynchronous durable-input/wake recovery resumes.
  const hasLiveAgentRunners = () => agentSessions.controller.activeCount() > 0
  const hasActiveRunners = () =>
    hasLiveAgentRunners() || trainJobs.hasRunningJob() || backupWorker.isRunning()
  const systemCommand = config.systemCommand ?? runSystemCommand
  const browserExtension = new BrowserExtensionBridge()
  const browserManager = createDesktopBrowserManager({
    store: createBrowserWindowLedgerStore(config.stateDir),
    extension: browserExtension,
    now: config.now,
    log: fields => logger.log('desktop', fields),
    agentSlugForId: agentId =>
      agentRoster.snapshot()?.find(agent => agent.kind === 'agent' && agent.agentId === agentId)
        ?.slug,
  })
  discardBrowserOwner = async agentAnchorId => {
    const agent = agentRoster
      .snapshot()
      ?.find(candidate => candidate.kind === 'agent' && candidate.anchorId === agentAnchorId)
    if (agent?.kind === 'agent') {
      await browserManager.removeOwner({ kind: 'agent', agentId: agent.agentId })
    }
  }
  const desktopSupervisor = createDesktopSupervisor({
    runCommand: systemCommand,
    reapBrowserMetrics: () =>
      reapBrowserMetrics({
        profileDir: resolve(config.stateDir, DESKTOP_CHROME_PROFILE_IN_STATE),
        now: config.now,
      }),
    clearStaleDisplayLock: () => clearStaleDisplayLock({ display: DESKTOP_DISPLAY }),
    hasLiveAgentRunners,
    isStartBlocked: () => maintenanceBlocksStarts,
    now: config.now,
    log: fields => logger.log('desktop', fields),
    lastBrowserActivityAt: () => browserManager.lastBrowserActivityAt(),
  })
  const browserReconciliation = createBrowserReconciliationTrigger({
    discoverGeneration: () => discoverBrowserGeneration(`http://127.0.0.1:${DESKTOP_CDP_PORT}`),
    reconcile: generation => browserManager.reconcile(generation),
  })
  browserExtension.subscribeConnection(() => {
    void browserReconciliation
      .connected()
      .then(result =>
        result === undefined
          ? undefined
          : logger.log('desktop', {
              operation: 'browser_reconcile',
              verdict: result.verdict,
              generation: result.ledger.browserGeneration,
              windows: result.ledger.windows.length,
              batches: result.ledger.batches.length,
            }),
      )
      .catch(error =>
        logger.log('desktop', {
          operation: 'browser_reconcile',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
  })
  browserExtension.subscribe(event => {
    void browserManager.handleExtensionEvent(event).catch(error =>
      logger.log('desktop', {
        operation: 'browser_extension_event',
        status: 'failed',
        event: event.event,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })
  const browserCdpGrants = createCdpGrantRegistry({ now: config.now })
  const browserBatches = createBrowserBatchService({
    resolveOwner: sessionId => agentSessions.controller.browserOwnerForSession(sessionId),
    ensureDesktop: desktopSupervisor.ensureStarted,
    reconcile: async () => {
      const generation = await discoverBrowserGeneration(`http://127.0.0.1:${DESKTOP_CDP_PORT}`)
      return await browserManager.reconcile(generation)
    },
    manager: browserManager,
    grants: browserCdpGrants,
  })
  const desktop = createDesktopIngress({
    now: config.now,
    fetch: config.desktopFetch,
    readKasmCredential:
      config.readKasmCredential ??
      (() => readKasmCredentialFile(resolve(config.stateDir, 'desktop', 'kasm-auth.json'))),
    lifecycle: desktopSupervisor,
    browserBatches,
    browserExtension,
    browserManager,
  })
  // Same startup path as sweepOrphanRunners: GC session-cgroup leaves leaked
  // by a previous gateway life (crash paths never rmdir their leaf).
  void runnerCgroupReady
    .then(() => sweepStaleRunnerLeaves(() => agentSessions.controller.activeSessionIds()))
    .catch(error =>
      logger.log('runner', {
        operation: 'stale_leaf_sweep_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  const runtimeUpdater = createRuntimeUpdater({
    apiUrl: config.apiUrl,
    stateDir: config.stateDir,
    runningVersion: config.runtimeVersion,
    desiredState,
    getVmToken,
    hasActiveRunners,
    blockStartsIfIdle: () => {
      if (maintenanceBlocksStarts) return null
      setStartsBlocked(true)
      if (hasActiveRunners()) {
        setStartsBlocked(false)
        return null
      }
      // Successful activation keeps admission closed until restart. The
      // updater invokes this on cancellation or any later cleanup failure.
      return () => setStartsBlocked(false)
    },
    fetch: config.fetch,
    extraHeaders: config.extraHeaders,
    releasesDir: config.releasesDir,
    currentReleaseLink: config.currentReleaseLink,
    maxDeferMs: config.runtimeUpdateMaxDeferMs,
    now: config.now,
    exit: config.exit,
    log: fields => logger.log('update', fields),
  })
  const phoneHome = createVmPhoneHome({
    config,
    setVmToken: token => {
      vmTokenMemory = token
    },
    restoreSuppression,
    restoreWindow,
  })
  const directiveSink: SyncDirectiveSink = {
    async acceptRuntimeRelease(descriptor) {
      await desiredState.acceptRuntimeRelease(descriptor)
    },
    async accept(payload) {
      // Both before desired state, because accepting desired state SPAWNS apps
      // and an app's environment is built from these: the model gateway address
      // from the credentials, and its own and its agent's folder from the
      // roster. Accepting either afterwards left every app in the first payload
      // — the whole fleet on a cold VM — without it until something restarted
      // them.
      modelCredentials.acceptResponse(payload)
      agentRoster.accept(payload.agents)
      await desiredState.accept(payload)
      await reconcileMirrorMachineAccess(
        { stateDir: config.stateDir, driveRoot: config.driveDir },
        payload.mirrorMachineIds,
        syncthingConfig,
        tunnelAccepts,
      )
      // Desired acceptance shares the puller's queue, so a concurrent archive
      // apply can never race a newer subscription identity. Keep that queue
      // detached: downloads and materialization must not block VM sync.
      void marketplacePuller.accept(payload.marketplace)
      for (const provider of payload.disconnectConnectedProviders ?? []) {
        // Per-provider isolation: one failed disconnect must not drop the rest
        // or block sync acceptance.
        void connectedProviders.disconnect(provider).catch(error =>
          logger.log('connected-providers', {
            operation: 'sync_disconnect',
            provider,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
      agentSessions.controller.setQuiesced(desiredState.current().quiesced)
      // Before the quiesce fork so both paths accept it: a quiesced response
      // carries an explicit [] and must clear, an absent field must preserve.
      const skills = payload.skills
      if (skills !== undefined) {
        // Sync remains detached, but agent starts wait on this tracked promise:
        // a freshly registered VM must not launch work while its default skills
        // still live only in the installer's partial staging directory. Repeated
        // syncs for the same hash coalesce; a failed attempt is retried by the
        // next sync and surfaces as runner_unavailable in the meantime.
        const operation = skillsInstallGate.track(skills.hash, async () => {
          const token = await getVmToken()
          if (token === null) throw new Error('VM token is unavailable for skills install')
          await installSkills({
            homeDir: dirname(config.stateDir),
            descriptor: skills,
            token,
            fetch: config.fetch,
            extraHeaders: config.extraHeaders,
            log: fields => logger.log('skills', fields),
          })
        })
        void operation.catch(error =>
          logger.log('skills', {
            operation: 'sync_install',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
      appCredentials.acceptResponse(payload)
      if (payload.quiesce === true) {
        // Per-workspace servicing quiesce: stop local application and agent
        // work without conflating it with the global updates.paused rollout bit.
        appsRoutes.supervisor.stop()
        shareConverger.accept({ shares: [] })
        // Quiescing application/agent work may be detached, but anchor state is
        // still part of release-health certification. A workspace stopping work
        // must not let this release record a healthy sync before its final
        // desired anchor roster is durable.
        await anchorRegistry.reconcileSync(payload.anchors)
        await bootHealth.recordSyncOk()
        void checkForUpdates().catch(logUpdateCycleError)
        return
      }
      await anchorRegistry.reconcileSync(payload.anchors)
      await bootHealth.recordSyncOk()
      if (payload.apps !== undefined) {
        appCredentials.reconcileDesiredApps(payload.apps)
        // Detached: app installs (a slow `npm install`) must never block the
        // sync loop — polling, boot health, and gateway self-update depend on it
        // returning promptly. The supervisor serializes + coalesces reconciles,
        // so the next tick re-drives the newest desired set if this one is still
        // installing.
        void appsRoutes.supervisor.reconcile(payload.apps).catch(error =>
          logger.log('apps', {
            operation: 'sync_reconcile',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
      if (payload.shareSync !== undefined) {
        shareConverger.accept(payload.shareSync)
      }
      void checkForUpdates().catch(logUpdateCycleError)
    },
  }
  const syncClient = createVmSyncClient({
    config: {
      apiUrl: config.apiUrl,
      workspaceHint: config.workspaceHint,
      fetch: config.fetch,
      extraHeaders: config.extraHeaders,
      log: fields => logger.log('sync', fields),
      backupPollAfterMs: backupWorker.pollAfterMs,
      beforeSync: async token => {
        await backupWorker.reconcile()
        await restoreWindow.run(() =>
          completePendingRestore({
            driveDir: config.driveDir,
            stateDir: config.stateDir,
            fetch: config.fetch,
            getVmToken: () => token,
            extraHeaders: config.extraHeaders,
            runCommand: config.systemCommand,
            suppression: restoreSuppression,
          }),
        )
      },
    },
    sink: directiveSink,
    getVmToken,
    setVmToken: token => {
      vmTokenMemory = token
    },
    trainReports: trainJobs,
    syncthingDeviceId: {
      read: () => readSyncthingDeviceId(syncthingClientOptions, config.fetch),
    },
    shareSyncReports: {
      reports: shareConverger.reports,
      acknowledge: shareConverger.acknowledge,
    },
    marketplacePullReports: {
      reports: marketplacePuller.reports,
      acknowledge: marketplacePuller.acknowledge,
    },
    appReconciliationReports: {
      reports: () => appsRoutes.supervisor.reports(),
      acknowledge: reports => appsRoutes.supervisor.acknowledge(reports),
    },
    reportedVersions,
    needsModelCredentials: () => modelCredentials.shouldRequestCredentials(config.now()),
    needsAppCredentials: () =>
      appCredentials.neededAppIds(appsRoutes.supervisor.desiredConfigs(), config.now()),
    registerOnce: phoneHome.registerOnce,
  })
  trainJobs.reconcileAtBoot()

  async function registerOnce(): Promise<RegisterResponse> {
    const registered = await phoneHome.registerOnce()
    const snapshot = VmSyncResponseSchema.safeParse(registered.sync)
    if (snapshot.success) await directiveSink.accept(snapshot.data)
    return registered
  }

  async function getVmToken(): Promise<string | null> {
    if (vmTokenMemory !== null) return vmTokenMemory
    vmTokenMemory = await readVmToken(config.stateDir)
    return vmTokenMemory
  }

  async function authenticate(
    request: Request,
    path: string,
  ): Promise<{ driveGrantActor?: string } | null> {
    // Desktop HTTP routes authorize once inside their ingress so the exact
    // origin resolved at admission reaches the proxy without a second clock check.
    if (desktopCredentialPathForRequest(path) !== null) return {}
    const drivePath = driveRelativePathForRequest(path)
    const queryGrant = new URL(request.url).searchParams.get('grant')
    if (drivePath !== null && queryGrant !== null && queryGrant.length > 0) {
      const permit = await driveGrants.authorize(
        queryGrant,
        request.method,
        drivePath,
        config.now(),
      )
      if (permit?.kind === 'download') return { driveGrantActor: permit.actor }
    }
    const token = extractBearerToken(request.headers.get('authorization'))
    if (token === null) return null
    const vmToken = await getVmToken()
    if (vmToken !== null && token === vmToken) return {}
    // The runner's integrations server lives here, and the runner speaks to it
    // with the workspace key this gateway handed it at spawn — the same bearer
    // ctl would have accepted, admitted for exactly that route.
    if (
      INTEGRATIONS_MCP_PATH.test(path) &&
      token === modelCredentials.currentModelEnv(config.now())?.DUET_API_KEY
    ) {
      return {}
    }
    const uploadScope = uploadScopeForPath(path)
    if (uploadScope !== null && (await uploadTokens.verify(uploadScope, token, config.now()))) {
      return {}
    }
    if (drivePath === null) return null
    const permit = await driveGrants.authorize(token, request.method, drivePath, config.now())
    return permit?.kind === 'upload' ? { driveGrantActor: permit.actor } : null
  }

  app.use('*', createUploadCorsPolicy(config.webAppOrigin ? [config.webAppOrigin] : []))

  app.use('*', async (c, next) => {
    const loggedPath = requestLogPath(c.req.path)
    const admission = isAuthAllowlisted(c.req.method, c.req.path)
      ? {}
      : await authenticate(c.req.raw, c.req.path)
    if (admission === null) {
      logger.log('request', { method: c.req.method, path: loggedPath, status: 401 })
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (admission.driveGrantActor !== undefined) {
      c.set('driveGrantActor', admission.driveGrantActor)
    }
    const started = config.now()
    try {
      await next()
      logger.log('request', {
        method: c.req.method,
        path: loggedPath,
        status: c.res.status,
        durationMs: Math.max(0, config.now() - started),
      })
    } catch (error) {
      logger.log('error', {
        method: c.req.method,
        path: loggedPath,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })

  app.get('/healthz', c => c.text('ok'))

  app.post('/v1/train/upload-token', async c => {
    return c.json(await mintUploadGrant(ROOT_UPLOAD_SCOPE))
  })

  app.post('/v1/train/agents/:anchorId/upload-token', async c => {
    let scope: TrainScope
    try {
      scope = resolveAgentTrainScope(c.req.param('anchorId'))
    } catch (error) {
      if (error instanceof TrainScopeResolutionError) {
        return trainScopeErrorResponse(error)
      }
      throw error
    }
    return c.json(await mintUploadGrant(scope.uploadsScope))
  })

  app.post('/v1/drive-grants', async c => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (body === null || typeof body.kind !== 'string') {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (
      body.kind === 'upload' &&
      Object.keys(body).length === 2 &&
      typeof body.pathPrefix === 'string'
    ) {
      // The drive root is an ordinary upload destination — the files tab lands
      // there whenever nobody has navigated into a folder.
      const pathPrefix = normalizeDrivePath(body.pathPrefix, { allowRoot: true })
      if (!pathPrefix.ok) return c.json({ error: 'invalid_path_prefix' }, 400)
      try {
        const grant = await driveGrants.mintUpload({
          pathPrefix: pathPrefix.relativePath,
          actor: c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? '',
          now: config.now(),
          ttlMs: config.uploadTokenTtlMs,
        })
        return c.json({
          uploadPath: driveFilePath(pathPrefix.relativePath),
          uploadToken: grant.token,
          expiresAt: grant.expiresAt,
        })
      } catch (error) {
        if (error instanceof InvalidDriveGrantError) {
          return c.json({ error: 'invalid_actor' }, 400)
        }
        throw error
      }
    }
    if (
      body.kind === 'download' &&
      Object.keys(body).length === 2 &&
      typeof body.path === 'string'
    ) {
      const path = normalizeDrivePath(body.path)
      if (!path.ok) return c.json({ error: 'invalid_path' }, 400)
      try {
        const grant = await driveGrants.mintDownload({
          path: path.relativePath,
          actor: c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? '',
          now: config.now(),
          ttlMs: config.uploadTokenTtlMs,
        })
        return c.json({
          downloadPath: `${driveFilePath(path.relativePath)}?grant=${encodeURIComponent(grant.token)}`,
          expiresAt: grant.expiresAt,
        })
      } catch (error) {
        if (error instanceof InvalidDriveGrantError) {
          return c.json({ error: 'invalid_actor' }, 400)
        }
        throw error
      }
    }
    return c.json({ error: 'invalid_request' }, 400)
  })

  async function mintUploadGrant(scope: UploadScope) {
    const grant = await uploadTokens.mint(scope, config.now(), config.uploadTokenTtlMs)
    return {
      uploadPath: trainUploadsPath(scope),
      uploadToken: grant.token,
      expiresAt: grant.expiresAt,
    }
  }

  function status() {
    return {
      instanceId,
      ...(bootId === undefined ? {} : { bootId }),
      imageVersion: config.imageVersion,
      runtimeVersion: config.runtimeVersion,
      uptimeSeconds: Math.max(0, Math.floor((config.now() - startedAt) / 1000)),
      diagnostics: {
        runtimeUpdateInFlight: updateCycle !== null,
        attribution: fileEvents.stats(),
        scanNudge: scanNudge.stats(),
        anchorReconcile: latestAnchorReconcile,
        restoreInFlight: restoreWindow.inFlight(),
        backup: backupWorker.snapshot(),
        bootHealthCertified: bootHealth.certified(),
      },
    }
  }

  app.get('/health', c => c.json(status()))

  // VM-token-only deterministic probe for the live cutover journey. It opens
  // the same restore window archive completion uses and asks the real anchor
  // reconciler to run inside it; no filesystem or durable state is changed.
  app.post('/v1/diagnostics/restore-window', async c => {
    const parsed = GatewayAnchorsReconcileRequestSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    latestAnchorReconcile = null
    const reports = await restoreWindow.run(() => anchorReconciler.reconcile(parsed.data.anchors))
    return c.json({
      reports,
      telemetry: latestAnchorReconcile,
      restoreInFlight: restoreWindow.inFlight(),
    })
  })

  app.route('/v1/connected-providers', createConnectedProvidersRoutes(connectedProviders))

  app.route('/v1/backups', createBackupRoutes(backupWorker))

  app.use('/v1/files/*', async (c, next) => {
    await driveUploadsReady
    if (c.req.method === 'PUT') requestTimeoutExtender?.(c.req.raw, 0)
    await next()
  })
  app.route(
    '/v1/files',
    createFilesRoutes({
      driveDir: config.driveDir,
      tempDir: driveUploadTempDir,
      emitFileEvent: fileEvents.emit,
      diskGuard,
    }),
  )
  app.route(
    '/v1/memory',
    createMemoryRoutes({
      dbPath: config.memoryDbPath,
      waitMs: config.memoryLockWaitMs,
      runner: config.duetRunner,
    }),
  )
  app.route(
    '/v1/skills',
    createSkillsRoutes({
      driveDir: config.driveDir,
      runner: config.duetRunner,
    }),
  )
  app.route(
    '/v1/agents/roster',
    createAgentRosterRoutes({
      agents: () => agentRoster.snapshot(),
      refresh: syncClient.syncOnce,
      driveDir: config.driveDir,
    }),
  )
  app.route(
    '/v1/train/uploads',
    createTrainUploadsRoutes({
      resolveStore: () => uploadsStores.forScope(ROOT_UPLOAD_SCOPE),
      capBytes: TRAIN_UPLOADS_CAP_BYTES,
      isRunning: () => trainJobs.hasRunningJob('root'),
      ready: uploadsReady,
    }),
  )
  app.route(
    '/v1/train/agents/:anchorId/uploads',
    createTrainUploadsRoutes({
      resolveStore: c =>
        uploadsStores.forScope(resolveAgentTrainScope(c.req.param('anchorId') ?? '').uploadsScope),
      capBytes: TRAIN_UPLOADS_CAP_BYTES,
      isRunning: c =>
        trainJobs.hasRunningJob(resolveAgentTrainScope(c.req.param('anchorId') ?? '').key),
      ready: uploadsReady,
    }),
  )
  const sharedTrainRouteOptions = {
    stateDir: config.stateDir,
    driveDir: config.driveDir,
    uploadsStores,
    runner: env.trainRunner,
    modelEnv: modelEnvForSpawn,
    emitFileEvent: fileEvents.emit,
    jobLedger: trainJobs,
    recordIndexesReady,
    assertRecordIndexReady: trainRecordIndexes.assertScopeReady,
    isStartBlocked: () => maintenanceBlocksStarts,
  }
  app.route(
    '/v1/train/agents/:anchorId',
    createTrainRoutes({
      ...sharedTrainRouteOptions,
      resolveScope: c => resolveAgentTrainScope(c.req.param('anchorId') ?? ''),
    }),
  )
  app.route(
    '/v1/train',
    createTrainRoutes({
      ...sharedTrainRouteOptions,
      resolveScope: () => resolveRootTrainScope(),
      listAgentScopes: () =>
        anchorRegistry
          .snapshot()
          .filter(anchor => anchor.agentId !== undefined)
          .flatMap(anchor => {
            try {
              return [{ key: anchor.id, scope: resolveAgentTrainScope(anchor.id) }]
            } catch {
              // A stale anchor must not make every other agent disappear from
              // the workspace Train directory.
              return []
            }
          }),
    }),
  )

  app.route(
    '/v1/sync',
    createSyncRoutes({
      tunnelAccepts,
      driveDir: config.driveDir,
      stateDir: config.stateDir,
      syncthingApiUrl: config.syncthingApiUrl,
      syncthingApiKey: config.syncthingApiKey,
      fetch: config.fetch,
      now: config.now,
      configCoordinator: syncthingConfig,
    }),
  )
  app.route(
    '/v1/tunnel',
    createMirrorTunnelRoutes({
      accepts: tunnelAccepts,
      getVmToken,
    }),
  )
  app.route('/v1/desktop', desktop.routes)
  app.route('/v1/agent', agentSessions.routes)
  app.route(
    '/v1/internal-admin',
    createInternalAdminRoutes({
      driveDir: config.driveDir,
      stateDir: config.stateDir,
      now: config.now,
      status,
      updateChrome: createChromeUpdater({
        runCommand: systemCommand,
        hasLiveAgentRunners: () => hasLiveAgentRunners() || maintenanceBlocksStarts,
        setStartsBlocked,
        runWithDesktopMaintenance: desktopSupervisor.runMaintenance,
      }).update,
    }),
  )
  app.route('/v1/apps', appsRoutes.reconcile)
  app.post('/v1/anchors/reconcile', async c => {
    const parsed = GatewayAnchorsReconcileRequestSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await anchorRegistry.reconcile(parsed.data.anchors)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })
  app.post('/v1/marketplace/pull', async c => {
    const parsed = VmDesiredMarketplaceAgentsSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    await marketplacePuller.accept(parsed.data)
    const reports = await marketplacePuller.pullNow()
    if (reports.some(report => report.state === 'error')) {
      return c.json({ error: 'pull_failed' as const, reports }, 502)
    }
    return c.json({ ok: true as const, reports })
  })
  // Listing eligibility + metadata for an agent folder. Read-only: it creates
  // nothing, so a refusal leaves no publish and no listing behind. The API
  // calls this BEFORE creating either.
  app.post('/v1/marketplace/inspect', async c => {
    const body = await readJson(c.req.raw)
    const agentPath =
      typeof body === 'object' && body !== null && 'agentPath' in body
        ? (body as { agentPath: unknown }).agentPath
        : undefined
    if (typeof agentPath !== 'string' || agentPath.length === 0) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await inspectListableAgent({ driveDir: config.driveDir, agentPath })
    // Typed refusals travel as `{ ok: false, error }`, the same envelope as the
    // success case — a bare `{ error }` would fail the client's union parse and
    // collapse every refusal into "gateway unavailable".
    return result.ok ? c.json(result) : c.json({ ok: false as const, error: result.error }, 409)
  })
  app.route('/public/app', appsRoutes.public)
  app.route(
    '/v1/publishes',
    createPublishesControlRoutes({
      driveDir: config.driveDir,
      stateDir: config.stateDir,
    }),
  )
  app.route(
    '/public/publish',
    createPublishesRoutes({
      driveDir: config.driveDir,
      stateDir: config.stateDir,
      emitFileEvent: fileEvents.emit,
    }),
  )

  app.onError((err, c) => {
    logger.log('error', {
      method: c.req.method,
      path: c.req.path,
      error: err.message,
    })
    return c.json({ error: 'internal_server_error' }, 500)
  })

  app.notFound(c => c.json({ error: 'not_found' }, 404))

  function resolveRootTrainScope(): TrainScope {
    return resolveTrainScope({
      anchors: anchorRegistry.snapshot(),
      driveDir: config.driveDir,
      stateDir: config.stateDir,
    })
  }

  function resolveAgentTrainScope(anchorId: string): TrainScope {
    return resolveTrainScope({
      anchorId,
      anchors: anchorRegistry.snapshot(),
      driveDir: config.driveDir,
      stateDir: config.stateDir,
    })
  }

  function checkForUpdates(): Promise<void> {
    updateRequested = true
    updateCycle ??= runRequestedUpdateCycles().finally(() => {
      updateCycle = null
      if (updateRequested) void checkForUpdates().catch(logUpdateCycleError)
    })
    return updateCycle
  }

  function setStartsBlocked(blocked: boolean): void {
    maintenanceBlocksStarts = blocked
    agentSessions.controller.setStartsBlocked(blocked)
  }

  async function runRequestedUpdateCycles(): Promise<void> {
    while (updateRequested) {
      updateRequested = false
      await runUpdateCycle()
    }
  }

  function logUpdateCycleError(error: unknown): void {
    logger.log('update', {
      operation: 'update_cycle',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  async function runUpdateCycle(): Promise<void> {
    await runtimeUpdater.check()
  }

  function modelEnvForSpawn(): Record<string, string> | null {
    const env = modelCredentials.currentModelEnv(config.now())
    if (env !== null) {
      if (normalizedApiUrl === undefined) return env
      return {
        ...env,
        DUET_API_URL: normalizedApiUrl,
        FIRECRAWL_API_URL: `${normalizedApiUrl}/v1/services/firecrawl`,
        FIRECRAWL_API_KEY: env.DUET_API_KEY,
      }
    }
    if (!loggedMissingModelCredentials) {
      loggedMissingModelCredentials = true
      logger.log('warning', {
        operation: 'spawn_model_credentials',
        message: 'model credentials unavailable; spawning without model gateway env',
      })
    }
    return null
  }

  /**
   * How this VM addresses ctl on a session's behalf, or why it cannot. The
   * bearer is the same Duet key for every kind of server, so a VM with no
   * model credentials or no identity yet can address none of them.
   */
  function ctlSessionTarget(
    sessionId: string,
  ):
    | { apiUrl: string; workspaceSlug: string; sessionId: string; apiKey: string }
    | { unavailable: 'model_credentials_unavailable' | 'workspace_address_unknown' } {
    const env = modelCredentials.currentModelEnv(config.now())
    if (env === null) return { unavailable: 'model_credentials_unavailable' }
    const workspaceSlug = desiredState.current().workspaceSlug
    if (config.apiUrl === undefined || workspaceSlug === undefined) {
      return { unavailable: 'workspace_address_unknown' }
    }
    return { apiUrl: config.apiUrl, workspaceSlug, sessionId, apiKey: env.DUET_API_KEY }
  }

  function mcpServersForSpawn(
    sessionId: string,
    launch: GatewayRunnerInputRequest['launch'],
  ): McpServersConfig | null {
    const target = ctlSessionTarget(sessionId)
    // "Cannot address any server" is a different answer from "this turn has
    // no servers", and a turn that quietly loses its tools is exactly the
    // failure this slice exists to stop — so say which one happened rather
    // than returning a bare null.
    if ('unavailable' in target) {
      if (launch.integrations !== undefined || launch.mcpServers !== undefined) {
        logger.log('warning', {
          operation: 'spawn_mcp_servers_unavailable',
          sessionId,
          reason: target.unavailable,
          message: 'spawning without MCP servers this turn asked for',
        })
      }
      return null
    }
    // The exchange overlaps the runner's boot: this runs as the process is
    // spawned, and the runner asks for it ~1.5s later. Wakes come through
    // here too, so a woken turn gets the same head start as a prompted one.
    if (launch.integrations !== undefined) {
      integrationsHandshake.warm(sessionId, integrationsProxyTarget(target))
    }
    return buildMcpServersConfig({ ...target, launch, localBaseUrl: localGatewayBaseUrl })
  }

  function integrationsUpstream(
    sessionId: string,
  ): { url: string; headers: Record<string, string> } | null {
    const target = ctlSessionTarget(sessionId)
    return 'unavailable' in target ? null : integrationsProxyTarget(target)
  }

  /**
   * A wake has no request behind it, so the launch marker it would otherwise
   * relaunch from is as old as the sleep. Both MCP fields are re-asked here for
   * the same reason the merge fail-closes them: a server removed while the
   * session slept must not come back when it wakes.
   */
  async function refreshTurnMcpForWake(
    sessionId: string,
  ): Promise<GatewaySessionIntegrationsRefreshResponse | undefined> {
    if (config.apiUrl === undefined) return undefined
    const token = await getVmToken()
    if (token === null) return undefined
    const response = await config.fetch(
      `${config.apiUrl.replace(/\/+$/g, '')}/v1/vm/agent/sessions/${encodeURIComponent(sessionId)}/integrations`,
      {
        method: 'POST',
        headers: { ...config.extraHeaders, authorization: `Bearer ${token}` },
      },
    )
    if (!response.ok) {
      throw new Error(`integration refresh failed with HTTP ${response.status}`)
    }
    return GatewaySessionIntegrationsRefreshResponseSchema.parse(await response.json())
  }

  function startSyncLoop(): void {
    marketplacePuller.start()
    syncClient.start()
  }

  function startSyncthingIntegrationLoop(): void {
    if (syncthingIntegrationStarted) return
    syncthingIntegrationStarted = true
    void (async () => {
      await ensureReadMountsWritable({
        stateDir: config.stateDir,
        driveDir: config.driveDir,
      }).catch(error =>
        logger.log('read-mode-enforcer', {
          operation: 'read_mount_writability_reconcile_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      let attempt = 0
      for (;;) {
        try {
          await reconcileSyncthingHardening(syncthingClientOptions, config.fetch, syncthingConfig)
          await reconcileSyncthingFromStore(
            {
              stateDir: config.stateDir,
              driveRoot: config.driveDir,
            },
            syncthingConfig,
          )
          break
        } catch (error) {
          const retryMs = Math.min(
            SYNCTHING_INTEGRATION_RETRY.maxMs,
            SYNCTHING_INTEGRATION_RETRY.baseMs * 2 ** attempt,
          )
          attempt += 1
          logger.log('syncthing-events', {
            operation: 'syncthing_initialization_failed',
            retryMs,
            error: error instanceof Error ? error.message : String(error),
          })
          await (config.syncthingRetryDelay ?? sleep)(retryMs)
        }
      }
      fileEvents.onEvent(scanNudge.onEvent)
      syncthingEvents.start()
      readModeEnforcer.start()
    })().catch(error =>
      logger.log('read-mode-enforcer', {
        operation: 'syncthing_integration_loop_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  function startHelperLoop(): void {
    if (helperLoopStarted) return
    helperLoopStarted = true
    void helperSupervisor.startWithSyncthingPidRefresh().catch(error =>
      logger.log('helper', {
        operation: 'helper_start_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    // Periodic attribution telemetry (L12) — the retention soak's data source
    // (MAP Q11): a week of these lines gives the event-volume numbers that
    // decide pruning cadence. Cumulative gauges; a log scraper diffs them.
    void (async () => {
      for (;;) {
        await sleep(ATTRIBUTION_STATS_LOG_MS)
        logger.log('attribution-stats', {
          ...fileEvents.stats(),
          running: helperSupervisor.stats().running,
        })
      }
    })().catch(error =>
      logger.log('attribution-stats', {
        operation: 'attribution_stats_loop_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  const memoryReflect = createMemoryReflectRail({
    stateDir: config.stateDir,
    memoryDbPath: config.memoryDbPath,
    anchors: anchorRegistry.snapshot,
    modelEnv: modelEnvForSpawn,
    // The same agent-CLI seam the memory and skills routes take, so a runtime
    // driven without the binary stays without it.
    runner: config.duetRunner,
    now: config.now,
    log: fields => logger.log('memory-reflect', fields),
  })

  function startMemoryReflectLoop(): void {
    memoryReflect.start()
  }

  let desktopLoopStarted = false
  function startDesktopLoop(): void {
    if (desktopLoopStarted) return
    desktopLoopStarted = true
    const tick = () =>
      void (async () => {
        if (browserExtension.connected()) {
          try {
            await browserManager.tick()
          } catch (error) {
            logger.log('desktop', {
              operation: 'browser_tick',
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        await desktopSupervisor.tick()
      })().catch(error =>
        logger.log('desktop', {
          operation: 'tick',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    tick()
    const timer = setInterval(tick, DESKTOP_TICK_MS)
    timer.unref?.()
  }

  return {
    app,
    installProcessGuards: () => installProcessGuards(event => logger.log('process', event)),
    startSyncLoop,
    startSyncthingIntegrationLoop,
    startHelperLoop,
    startDesktopLoop,
    startMemoryReflectLoop,
    registerOnce,
    syncOnce: syncClient.syncOnce,
    getVmToken,
    routeSpecs,
    desiredState,
    tunnelAccepts,
    tunnelWebSocket,
    desktop,
    browserExtension,
    browserManager,
    browserCdpGrants,
    desktopSupervisor,
    fileEvents,
    setRequestTimeoutExtender: extender => {
      requestTimeoutExtender = extender
    },
  }

  function routeSpecs(): Array<{ method: string; path: string }> {
    return app.routes
      .filter(route => route.method !== 'ALL')
      .map(route => ({ method: route.method, path: route.path }))
  }

  async function reportedVersions() {
    return {
      runtime: config.runtimeVersion,
      image: config.imageVersion,
    }
  }

  async function reportMoveCandidates(reports: AnchorMoveCandidatesReport[]): Promise<void> {
    if (config.apiUrl === undefined) return
    const token = await getVmToken()
    if (token === null) return
    const response = await config.fetch(
      `${config.apiUrl.replace(/\/+$/g, '')}/v1/vm/anchors/move-candidates`,
      {
        method: 'POST',
        headers: {
          ...config.extraHeaders,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reports }),
      },
    )
    if (!response.ok) throw new Error(`anchor move report failed with HTTP ${response.status}`)
  }
}

export function startGatewayFromEnv(env = process.env): void {
  const port = Number(env.PORT ?? '3000')
  const runtime = createGatewayRuntime({
    port,
    provisioningToken: env.DUET_PROVISIONING_TOKEN,
    apiUrl: env.DUET_API_URL,
    workspaceHint: env.DUET_WORKSPACE_HINT,
    stateDir: env.DUET_STATE_DIR,
    driveDir: env.DUET_DRIVE_DIR,
    runtimeVersion: env.DUET_RUNTIME_VERSION,
    imageVersion: env.DUET_IMAGE_VERSION,
    webAppOrigin: env.DUET_WEB_APP_ORIGIN,
    memoryDbPath: env.DUET_MEMORY_DB_PATH,
    memoryLockWaitMs: env.DUET_MEMORY_LOCK_WAIT_MS
      ? Number(env.DUET_MEMORY_LOCK_WAIT_MS)
      : undefined,
    syncthingApiUrl: env.SYNCTHING_API_URL,
    syncthingApiKey: env.SYNCTHING_API_KEY,
    extraHeaders: parseExtraHeaders(env.DUET_GATEWAY_EXTRA_HEADERS_JSON),
  })
  runtime.installProcessGuards()
  runtime.startSyncLoop()
  runtime.startSyncthingIntegrationLoop()
  runtime.startHelperLoop()
  runtime.startDesktopLoop()
  runtime.startMemoryReflectLoop()
  let server: Bun.Server<GatewaySocketData>
  const upgradeHandlers: WebSocketUpgradeHandler[] = [
    request => handleTunnelUpgrade(request, server, runtime.tunnelAccepts),
    request => handleBrowserExtensionUpgrade(request, server, runtime.browserExtension),
    request =>
      handleDesktopCdpUpgrade(request, server as unknown as Bun.Server<DesktopCdpSocketData>, {
        grants: runtime.browserCdpGrants,
        discoverUpstream: () => discoverBrowserWebSocket(`http://127.0.0.1:${DESKTOP_CDP_PORT}`),
        manager: runtime.browserManager,
      }),
    request => handleDesktopUpgrade(request, server, runtime.desktop),
  ]
  server = Bun.serve<GatewaySocketData>({
    port,
    ...gatewayServeLimits,
    fetch: async request => {
      const upgradeResponse = await runWebSocketUpgradeHandlers(request, upgradeHandlers)
      if (upgradeResponse !== null) return upgradeResponse
      return runtime.app.fetch(request)
    },
    websocket: createWebSocketRouter<GatewaySocketData>({
      tunnel: runtime.tunnelWebSocket,
      'browser-extension': browserExtensionWebSocketHandlers(),
      'desktop-cdp': desktopCdpWebSocketHandlers(),
      desktop: desktopWebSocketHandlers(),
    }),
  })
  // Hardening, not a fix for an observed bug: confirmed directly that Bun
  // kills an in-flight unary handler at idleTimeout regardless of what it's
  // doing — BUT also confirmed that a request whose body has already been
  // read (which /input always does, before this fires) is not subject to
  // that kill, incidentally. This makes the protection explicit rather than
  // relying on that incidental ordering surviving every future refactor of
  // the route or Bun/Hono version. See agentSessions.test.ts for both halves.
  runtime.setRequestTimeoutExtender((request, seconds) => server.timeout(request, seconds))
}

function shouldEnsureAgentRunner(env: GatewayEnv): boolean {
  return env.agentRunnerFactory === undefined
}

function driveRelativePathForRequest(path: string): string | null {
  if (!path.startsWith('/v1/files/')) return null
  const normalized = normalizeDriveUrlPath(path.slice('/v1/files/'.length))
  return normalized.ok ? normalized.relativePath : null
}

/**
 * The route that addresses one Drive path, or the Drive root itself.
 *
 * The root is the empty relative path, and it must not leave a trailing slash:
 * a grant on it has a filename appended to build each upload's URL, and
 * `/v1/files/` + `/name` is a double separator the path normalizer refuses.
 */
function driveFilePath(relativePath: string): string {
  const segments = relativePath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => encodeURIComponent(segment))
  return ['/v1/files', ...segments].join('/')
}

const INTEGRATIONS_MCP_PATH = /^\/v1\/agent\/sessions\/[^/]+\/integrations\/mcp$/

function isAuthAllowlisted(method: string, path: string): boolean {
  return GATEWAY_AUTH_ALLOWLIST.some(route => route.method === method && route.path === path)
}

function requestLogPath(path: string): string {
  if (
    path === '/v1/desktop/grants' ||
    path === '/v1/desktop/status' ||
    path.startsWith('/v1/desktop/browser/') ||
    path.startsWith('/v1/desktop/browser-extension/')
  ) {
    return path
  }
  if (!path.startsWith('/v1/desktop/')) return path
  const tailStart = path.indexOf('/', '/v1/desktop/'.length)
  return `/v1/desktop/:credential${tailStart === -1 ? '' : path.slice(tailStart)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}
