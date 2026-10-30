import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'

import { Hono } from 'hono'

import {
  DUET_APP_SLUG_HEADER,
  DUET_ORIGINAL_HOST_HEADER,
  FORWARDED_HOST_HEADER,
  GatewayAppsReconcileRequestSchema,
  isPathInside,
  MAX_APP_RECONCILIATION_ERROR_UTF8_BYTES,
  sameGatewayAppConfig,
  sameGatewayAppRuntimeConfig,
  truncateUtf8,
  type AppReconciliationReport,
  type GatewayAppConfig,
} from '@repo/contract'

import { resolveAppFolder } from '../apps/app-folder'
import {
  DEFAULT_BUILD_ACTIVITY_HOT_WINDOW_MS,
  DEFAULT_BUILD_ACTIVITY_MAX_ENTRIES,
  DEFAULT_BUILD_ACTIVITY_MAX_FILES,
  probeBuildActivity,
  type BuildActivity,
} from '../apps/build-activity'
import { decideBuildingFallback } from '../apps/building-fallback'
import { renderBuildingPage } from '../apps/building-page'
import { buildAppSpawnEnv } from '../apps/spawn-env'
import { redactText } from '../redaction'

const STARTUP_GRACE_MS = 250
const SERVICE_RETRY_INTERVAL_MS = 300
const SERVICE_RETRY_ATTEMPTS = 33
const SERVICE_RESPAWN_BASE_DELAY_MS = 1_000
const SERVICE_RESPAWN_MAX_DELAY_MS = 30_000
const INSTALL_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000
const STDERR_BUFFER_LIMIT = 50

const CONNECTION_NOT_ESTABLISHED_CODES = new Set([
  'ECONNREFUSED',
  'ConnectionRefused',
  'UND_ERR_CONNECT_TIMEOUT',
])
const AMBIGUOUS_SOCKET_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'])
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface AppsRoutes {
  reconcile: Hono
  public: Hono
  supervisor: AppSupervisor
}

export interface AppSupervisorOptions {
  driveDir: string
  spawnEnvExtras?: (app: GatewayAppConfig) => Record<string, string>
  respawnBaseDelayMs?: number
  respawnMaxDelayMs?: number
  startupBindTimeoutMs?: number
  startupGraceMs?: number
  installTimeoutMs?: number
}

export interface AppReconcileOptions {
  requiredReadySlugs?: readonly string[]
}

interface ManagedProcess {
  app: GatewayAppConfig
  claim: PortClaim
  process: ChildProcess
  ready: boolean
  stderrBuffer: string[]
}

interface PortClaim {
  slug: string
}

interface ActiveInstall {
  app: GatewayAppConfig
  process: ChildProcess
  completion: Promise<void>
}

interface ActiveAppReconcile {
  app: GatewayAppConfig
  completion: Promise<void>
}

class InstallCommandError extends Error {}

export function createAppsRoutes(options: AppSupervisorOptions): AppsRoutes {
  const supervisor = new AppSupervisor(options)
  const reconcile = new Hono()
  const publicRoutes = new Hono()

  reconcile.post('/reconcile', async c => {
    const parsed = GatewayAppsReconcileRequestSchema.safeParse(await readJson(c.req.raw))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await supervisor.reconcile(parsed.data.apps, {
        requiredReadySlugs: parsed.data.requiredReadySlugs,
      })
      return c.json({ ok: true, apps: supervisor.list() })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  publicRoutes.all('/', c => supervisor.handleProxy(c.req.raw))
  publicRoutes.all('/*', c => supervisor.handleProxy(c.req.raw))

  return { reconcile, public: publicRoutes, supervisor }
}

export class AppSupervisor {
  private desired = new Map<string, GatewayAppConfig>()
  private processes = new Map<string, ManagedProcess>()
  // The scheduled config rides along with the timer: a reconcile pass needs to
  // tell "a retry for exactly this config is already pending" from "the config
  // changed, so the pending retry is stale".
  private respawnTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; app: GatewayAppConfig }
  >()
  private respawnDelay = new Map<string, number>()
  private installedConfigs = new Map<string, GatewayAppConfig>()
  private activeInstalls = new Map<string, ActiveInstall>()
  private stoppingSlugs = new Set<string>()
  private portClaims = new Map<number, PortClaim>()
  private pendingReconcile: Map<string, GatewayAppConfig> | null = null
  private reconcileLoop: Promise<Map<string, string>> | null = null
  private activeAppReconciles = new Map<string, ActiveAppReconcile>()
  private reconciliationReports = new Map<string, AppReconciliationReport>()
  private lastReconciliationReports = new Map<string, AppReconciliationReport>()
  private readonly driveDir: string
  private readonly spawnEnvExtras?: (app: GatewayAppConfig) => Record<string, string>
  private readonly respawnBaseDelayMs: number
  private readonly respawnMaxDelayMs: number
  private readonly startupBindTimeoutMs: number
  private readonly startupGraceMs: number
  private readonly installTimeoutMs: number

  constructor(options: AppSupervisorOptions) {
    this.driveDir = options.driveDir
    this.spawnEnvExtras = options.spawnEnvExtras
    this.respawnBaseDelayMs = options.respawnBaseDelayMs ?? SERVICE_RESPAWN_BASE_DELAY_MS
    this.respawnMaxDelayMs = options.respawnMaxDelayMs ?? SERVICE_RESPAWN_MAX_DELAY_MS
    this.startupBindTimeoutMs =
      options.startupBindTimeoutMs ?? SERVICE_RETRY_INTERVAL_MS * SERVICE_RETRY_ATTEMPTS
    this.startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS
    this.installTimeoutMs = options.installTimeoutMs ?? INSTALL_COMMAND_TIMEOUT_MS
  }

  // Background snapshots are serialized + latest-wins, while direct mutations
  // reconcile only their required slugs and can proceed beside an unrelated
  // long-running install. Per-app reconciliation remains serialized below.
  // `desired` is set synchronously so `list()` is always current.
  async reconcile(apps: GatewayAppConfig[], options: AppReconcileOptions = {}): Promise<void> {
    const next = new Map(apps.map(app => [app.slug, app]))
    const desiredChanged = !sameDesiredAppConfigs(this.desired, next)
    const changedSlugs = new Set(
      apps
        .filter(app => {
          const previous = this.desired.get(app.slug)
          return previous === undefined || !sameGatewayAppConfig(previous, app)
        })
        .map(app => app.slug),
    )
    this.desired = next
    if (options.requiredReadySlugs !== undefined) {
      if (desiredChanged || this.reconcileLoop === null) this.pendingReconcile = next
      const requiredReadySlugs = new Set(options.requiredReadySlugs)
      const errors = await this.applyDesired(next, requiredReadySlugs)
      const reportableSlugs = new Set(
        [...requiredReadySlugs].filter(
          slug => errors.has(slug) || sameDesiredAppConfigAtSlug(this.desired, next, slug),
        ),
      )
      this.recordReconciliationReports(next, errors, reportableSlugs)
      const firstError = [...errors].find(([slug]) => requiredReadySlugs.has(slug))?.[1]
      if (firstError !== undefined) {
        if (this.pendingReconcile === next) this.pendingReconcile = null
        throw new Error(firstError)
      }
      if (
        [...requiredReadySlugs].some(slug => !sameDesiredAppConfigAtSlug(this.desired, next, slug))
      ) {
        if (this.pendingReconcile !== null) this.kickReconcileLoop()
        throw new Error('App reconciliation was superseded by newer desired state')
      }
      if (this.pendingReconcile !== null) this.kickReconcileLoop()
      return
    }
    this.pendingReconcile = next
    const finalErrors = await this.ensureReconcileLoop()
    const requiredReadySlugs = changedSlugs
    const firstError = [...finalErrors].find(([slug]) => requiredReadySlugs.has(slug))?.[1]
    if (firstError !== undefined) throw new Error(firstError)
  }

  private ensureReconcileLoop(): Promise<Map<string, string>> {
    if (this.reconcileLoop !== null) return this.reconcileLoop
    const loop = this.runReconcileLoop()
    this.reconcileLoop = loop
    return loop
  }

  private kickReconcileLoop(): void {
    void this.ensureReconcileLoop().catch(error => {
      console.error('[apps] background reconciliation failed:', error)
    })
  }

  private async runReconcileLoop(): Promise<Map<string, string>> {
    let finalErrors = new Map<string, string>()
    try {
      while (this.pendingReconcile !== null) {
        const target = this.pendingReconcile
        this.pendingReconcile = null
        finalErrors = await this.applyDesired(target)
        if (sameDesiredAppConfigs(this.desired, target)) {
          this.recordReconciliationReports(target, finalErrors)
        } else if (finalErrors.size > 0) {
          this.recordReconciliationReports(target, finalErrors, new Set(finalErrors.keys()))
        }
      }
      return finalErrors
    } finally {
      this.reconcileLoop = null
      if (this.pendingReconcile !== null) this.kickReconcileLoop()
    }
  }

  private async applyDesired(
    next: Map<string, GatewayAppConfig>,
    observedSlugs?: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    for (const active of this.activeInstalls.values()) {
      const desired = next.get(active.app.slug)
      if (desired === undefined || !sameGatewayAppRuntimeConfig(active.app, desired)) {
        killInstallProcess(active.process)
      }
    }
    const starts: Array<{ slug: string; promise: Promise<void> }> = []
    for (const [slug, app] of next) {
      if (observedSlugs !== undefined && !observedSlugs.has(slug)) continue
      starts.push({ slug, promise: this.reconcileApp(app) })
    }
    const results = await Promise.allSettled(starts.map(start => start.promise))
    for (const [slug, managed] of this.processes) {
      if (this.desired.has(slug)) continue
      // No longer desired: the failure history dies with the app, so a future
      // re-add starts from a clean backoff rather than inheriting this one.
      this.clearRespawnBackoff(slug)
      this.stopProcess(slug, managed)
      this.processes.delete(slug)
    }
    for (const slug of this.installedConfigs.keys()) {
      if (!this.desired.has(slug)) this.installedConfigs.delete(slug)
    }
    const errors = new Map<string, string>()
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      errors.set(starts[index]!.slug, errorMessage(result.reason))
    })
    const slugsToObserve = observedSlugs ?? new Set(next.keys())
    for (const slug of slugsToObserve) {
      const app = next.get(slug)
      if (app === undefined) continue
      const managed = this.processes.get(slug)
      if (
        managed !== undefined &&
        managed.ready &&
        sameGatewayAppRuntimeConfig(managed.app, app) &&
        this.portClaims.get(app.port) === managed.claim
      ) {
        continue
      }
      if (!errors.has(slug)) errors.set(slug, `App "${slug}" did not become ready`)
    }
    return errors
  }

  private reconcileApp(app: GatewayAppConfig): Promise<void> {
    const active = this.activeAppReconciles.get(app.slug)
    if (active !== undefined && sameGatewayAppRuntimeConfig(active.app, app)) {
      return active.completion
    }
    const completion = (async () => {
      if (active !== undefined) await active.completion.catch(() => undefined)
      const desired = this.desired.get(app.slug)
      // Supersession is judged on runtime identity: a metadata-only desired
      // drift (rename) must not cancel queued runtime work, or a sharing
      // caller reports "did not become ready" for work that was simply
      // abandoned. Full equality stays the rule for reports elsewhere.
      if (desired === undefined || !sameGatewayAppRuntimeConfig(desired, app)) return
      const existing = this.processes.get(app.slug)
      // A retry already queued for this exact config owns the restart. Poll-
      // driven reconciles arrive far more often than the backoff delay, so
      // cancelling and respawning here would pin the retry rate to the poll
      // rate and a crash-looping app would never get its widening gap.
      const pending = this.respawnTimers.get(app.slug)
      if (
        existing === undefined &&
        pending !== undefined &&
        sameGatewayAppRuntimeConfig(pending.app, app)
      ) {
        return
      }
      // Any other path is a real change of intent, so the failure history that
      // produced the pending retry no longer describes what we are starting.
      this.clearRespawnBackoff(app.slug)
      if (existing !== undefined && !sameGatewayAppRuntimeConfig(existing.app, app)) {
        await this.replaceProcessAfterInstall(existing, app)
        return
      }
      if (existing === undefined) await this.respawnWithPortCheck(app)
    })()
    const entry = { app, completion }
    this.activeAppReconciles.set(app.slug, entry)
    void completion.then(
      () => {
        if (this.activeAppReconciles.get(app.slug) === entry) {
          this.activeAppReconciles.delete(app.slug)
        }
      },
      () => {
        if (this.activeAppReconciles.get(app.slug) === entry) {
          this.activeAppReconciles.delete(app.slug)
        }
      },
    )
    return completion
  }

  list(): string[] {
    return [...this.desired.keys()].sort()
  }

  desiredConfigs(): readonly GatewayAppConfig[] {
    return [...this.desired.values()]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(config => structuredClone(config))
  }

  reports(): AppReconciliationReport[] {
    return [...this.reconciliationReports.values()].sort((a, b) => a.slug.localeCompare(b.slug))
  }

  acknowledge(reports: AppReconciliationReport[]): void {
    for (const report of reports) {
      const current = this.reconciliationReports.get(report.slug)
      if (current !== undefined && sameAppReconciliationReport(current, report)) {
        this.reconciliationReports.delete(report.slug)
      }
    }
  }

  // Queued through activeAppReconciles so a restart never races the spawn,
  // verify, or replace steps of an in-flight reconcile for the same app.
  restartApp(appId: string): void {
    const app = [...this.desired.values()].find(candidate => candidate.appId === appId)
    if (app === undefined) return
    const active = this.activeAppReconciles.get(app.slug)
    const completion = (async () => {
      if (active !== undefined) await active.completion.catch(() => undefined)
      const desired = this.desired.get(app.slug)
      if (desired === undefined || !sameGatewayAppRuntimeConfig(desired, app)) return
      const existing = this.processes.get(app.slug)
      // A process that is not running spawns with the fresh store env anyway.
      if (existing === undefined) return
      this.cancelPendingRespawn(app.slug)
      await this.replaceProcessAfterInstall(existing, desired)
    })()
    const entry = { app, completion }
    this.activeAppReconciles.set(app.slug, entry)
    void completion.then(
      () => {
        if (this.activeAppReconciles.get(app.slug) === entry) {
          this.activeAppReconciles.delete(app.slug)
        }
      },
      () => {
        if (this.activeAppReconciles.get(app.slug) === entry) {
          this.activeAppReconciles.delete(app.slug)
        }
      },
    )
  }

  stop(): void {
    for (const pending of this.respawnTimers.values()) clearTimeout(pending.timer)
    this.respawnTimers.clear()
    this.respawnDelay.clear()
    this.installedConfigs.clear()
    this.desired.clear()
    this.pendingReconcile = null
    this.reconciliationReports.clear()
    this.lastReconciliationReports.clear()
    for (const active of this.activeInstalls.values()) killInstallProcess(active.process)
    for (const [slug, managed] of this.processes) {
      this.stopProcess(slug, managed)
    }
    this.processes.clear()
    this.portClaims.clear()
  }

  async handleProxy(request: Request): Promise<Response> {
    const match = proxyTarget(request)
    if (match === null) return Response.json({ error: 'unknown_app' }, { status: 404 })
    if (isEnvPath(match.path)) return Response.json({ error: 'not_found' }, { status: 404 })
    const app = this.desired.get(match.slug)
    if (app === undefined) return Response.json({ error: 'unknown_app' }, { status: 404 })
    const managed = this.processes.get(match.slug)
    if (
      managed === undefined ||
      !managed.ready ||
      !sameGatewayAppRuntimeConfig(managed.app, app) ||
      this.portClaims.get(app.port) !== managed.claim
    ) {
      const acceptsHtml = requestAcceptsHtml(request)
      if (!canProbeBuildingFallback(request.method, match.path, acceptsHtml, 'unavailable')) {
        return Response.json({ error: 'app_unavailable' }, { status: 502 })
      }
      const activity = await this.buildActivity(app)
      if (
        decideBuildingFallback({
          method: request.method,
          path: match.path,
          acceptsHtml,
          upstream: 'unavailable',
          activity,
        }).kind === 'building'
      ) {
        return buildingResponse(request.method, app, activity)
      }
      return Response.json({ error: 'app_unavailable' }, { status: 502 })
    }
    const proxyResponse = await this.proxyToService(app, match.path, request)
    const acceptsHtml = requestAcceptsHtml(request)
    const upstream = { status: proxyResponse.status }
    if (!canProbeBuildingFallback(request.method, match.path, acceptsHtml, upstream)) {
      return proxyResponse
    }
    const activity = await this.buildActivity(app)
    if (
      decideBuildingFallback({
        method: request.method,
        path: match.path,
        acceptsHtml,
        upstream,
        activity,
      }).kind === 'building'
    ) {
      await proxyResponse.body?.cancel().catch(() => undefined)
      return buildingResponse(request.method, app, activity)
    }
    return proxyResponse
  }

  private async buildActivity(app: GatewayAppConfig): Promise<BuildActivity> {
    try {
      return await probeBuildActivity({
        driveDir: this.driveDir,
        anchorPath: app.anchorPath,
        nowMs: Date.now(),
        hotWindowMs: DEFAULT_BUILD_ACTIVITY_HOT_WINDOW_MS,
        maxEntries: DEFAULT_BUILD_ACTIVITY_MAX_ENTRIES,
        maxFiles: DEFAULT_BUILD_ACTIVITY_MAX_FILES,
      })
    } catch {
      return { hot: false, recentFiles: [], truncated: false }
    }
  }

  private async spawnService(app: GatewayAppConfig, claim: PortClaim): Promise<ManagedProcess> {
    const cwd = (await resolveAppFolder(this.driveDir, app.anchorPath)).path
    // Bun/Node spawn accepts cwd only as a path, not a directory fd; revalidate immediately before use.
    await assertSafeCwd(this.driveDir, cwd)
    const child = spawn('bash', ['-c', app.command], {
      cwd,
      env: buildAppSpawnEnv({
        base: process.env,
        port: app.port,
        extras: this.spawnEnvExtras?.(app),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const managed: ManagedProcess = { app, claim, process: child, ready: false, stderrBuffer: [] }

    child.stdout?.on('data', (data: Buffer) => {
      console.info(`[apps:${app.slug}:stdout]`, redactText(data.toString().trimEnd()))
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = redactText(data.toString().trimEnd())
      managed.stderrBuffer.push(text)
      if (managed.stderrBuffer.length > STDERR_BUFFER_LIMIT) managed.stderrBuffer.shift()
      console.warn(`[apps:${app.slug}:stderr]`, text)
    })
    child.on('error', error => {
      console.error(`[apps] failed to spawn "${app.slug}":`, error)
      if (this.processes.get(app.slug) === managed) this.processes.delete(app.slug)
      this.releasePortClaim(managed)
      this.scheduleRespawn(app)
    })
    child.on('exit', (code, signal) => {
      console.warn(`[apps] service "${app.slug}" exited (code=${code}, signal=${signal})`)
      if (this.processes.get(app.slug) === managed) this.processes.delete(app.slug)
      this.releasePortClaim(managed)
      if (this.stoppingSlugs.delete(app.slug)) return
      terminateService(child)
      this.scheduleRespawn(app)
    })

    this.processes.set(app.slug, managed)
    // Forgive the backoff only once THIS process has proven it stays up. Mere
    // presence in the map is not proof: a crash-looping child is in the map for
    // the instant between spawn and exit.
    setTimeout(() => {
      if (this.processes.get(app.slug) === managed && managed.ready) {
        this.respawnDelay.delete(app.slug)
      }
    }, this.startupGraceMs * 2)
    return managed
  }

  private async runInstallCommand(app: GatewayAppConfig): Promise<void> {
    if (app.installCommand === undefined) return
    const cwd = (await resolveAppFolder(this.driveDir, app.anchorPath)).path
    await assertSafeCwd(this.driveDir, cwd)
    const child = spawn('bash', ['-c', app.installCommand], {
      cwd,
      detached: process.platform !== 'win32',
      env: buildAppSpawnEnv({ base: process.env, port: app.port }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderrBuffer: string[] = []
    child.stdout?.on('data', (data: Buffer) => {
      console.info(`[apps:${app.slug}:stdout]`, data.toString().trimEnd())
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd()
      stderrBuffer.push(text)
      if (stderrBuffer.length > STDERR_BUFFER_LIMIT) stderrBuffer.shift()
      console.warn(`[apps:${app.slug}:stderr]`, text)
    })
    const completion = new Promise<void>((resolveInstall, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error === undefined) resolveInstall()
        else reject(error)
      }
      const timeout = setTimeout(() => {
        killInstallProcess(child)
        finish(
          new InstallCommandError(
            `Install command for "${app.slug}" timed out after ${this.installTimeoutMs}ms`,
          ),
        )
      }, this.installTimeoutMs)
      child.once('error', error => {
        finish(
          new InstallCommandError(
            `Install command for "${app.slug}" failed to spawn: ${error.message}`,
          ),
        )
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          finish()
          return
        }
        const stderr = stderrBuffer.join('\n').slice(0, 2000)
        finish(
          new InstallCommandError(
            `Install command for "${app.slug}" failed (code=${code}, signal=${signal}).${stderr ? `\nstderr:\n${stderr}` : ''}`,
          ),
        )
      })
    })
    const active = { app, process: child, completion }
    this.activeInstalls.set(app.slug, active)
    try {
      await completion
    } finally {
      if (this.activeInstalls.get(app.slug) === active) this.activeInstalls.delete(app.slug)
    }
  }

  private async ensureInstalled(app: GatewayAppConfig): Promise<void> {
    const installed = this.installedConfigs.get(app.slug)
    if (installed !== undefined && sameGatewayAppRuntimeConfig(installed, app)) return
    const active = this.activeInstalls.get(app.slug)
    if (active !== undefined) {
      if (sameGatewayAppRuntimeConfig(active.app, app)) {
        await active.completion
        return
      } else {
        killInstallProcess(active.process)
        await active.completion.catch(() => undefined)
      }
    }
    await this.runInstallCommand(app)
    const desired = this.desired.get(app.slug)
    if (desired !== undefined && sameGatewayAppRuntimeConfig(desired, app)) {
      this.installedConfigs.set(app.slug, app)
    }
  }

  private async replaceProcessAfterInstall(
    existing: ManagedProcess,
    app: GatewayAppConfig,
  ): Promise<void> {
    try {
      await this.ensureInstalled(app)
    } catch (error) {
      this.restoreDesiredApp(existing.app)
      console.error(`[apps] install of "${app.slug}" failed:`, error)
      if (error instanceof InstallCommandError) throw error
      return
    }
    const desired = this.desired.get(app.slug)
    if (desired === undefined || !sameGatewayAppRuntimeConfig(desired, app)) return
    this.stopProcess(app.slug, existing)
    this.processes.delete(app.slug)
    await waitForPortRelease(app.port, Math.max(100, this.startupGraceMs * 4))
    await this.respawnWithPortCheck(app)
    const replacement = this.processes.get(app.slug)
    if (
      replacement !== undefined &&
      replacement.ready &&
      sameGatewayAppRuntimeConfig(replacement.app, app) &&
      this.portClaims.get(app.port) === replacement.claim
    ) {
      return
    }
    const currentDesired = this.desired.get(app.slug)
    if (currentDesired === undefined || !sameGatewayAppRuntimeConfig(currentDesired, app)) return
    this.restoreDesiredApp(existing.app)
    this.cancelPendingRespawn(app.slug)
    await waitForPortRelease(existing.app.port, Math.max(100, this.startupGraceMs * 4))
    await this.respawnWithPortCheck(existing.app)
  }

  private restoreDesiredApp(app: GatewayAppConfig): void {
    const restored = new Map(this.desired)
    restored.set(app.slug, app)
    this.desired = restored
  }

  private async proxyToService(
    app: GatewayAppConfig,
    requestPath: string,
    request: Request,
  ): Promise<Response> {
    const incoming = new URL(request.url)
    const targetUrl = `http://127.0.0.1:${app.port}${requestPath}${incoming.search}`
    for (let attempt = 0; attempt <= SERVICE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const headers = new Headers(request.headers)
        headers.delete('host')
        headers.delete('authorization')
        const originalHost = headers.get(DUET_ORIGINAL_HOST_HEADER)
        if (originalHost !== null) headers.set(FORWARDED_HOST_HEADER, originalHost)
        headers.delete(DUET_ORIGINAL_HOST_HEADER)
        const proxyResponse = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
          duplex: 'half',
          signal: request.signal,
        } as RequestInit & { duplex: 'half' })
        const responseHeaders = new Headers(proxyResponse.headers)
        responseHeaders.delete('content-encoding')
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          statusText: proxyResponse.statusText,
          headers: responseHeaders,
        })
      } catch (error) {
        if (isRetriableProxyError(error, request.method) && attempt < SERVICE_RETRY_ATTEMPTS) {
          await sleep(SERVICE_RETRY_INTERVAL_MS)
          continue
        }
        console.error(`[apps] proxy to "${app.slug}" failed:`, error)
        return Response.json({ error: 'app_unavailable' }, { status: 502 })
      }
    }
    return Response.json({ error: 'app_unavailable' }, { status: 502 })
  }

  private scheduleRespawn(app: GatewayAppConfig): void {
    const desired = this.desired.get(app.slug)
    if (desired === undefined || !sameGatewayAppRuntimeConfig(desired, app)) return
    const prevDelay = this.respawnDelay.get(app.slug) ?? this.respawnBaseDelayMs / 2
    const delay = Math.min(prevDelay * 2, this.respawnMaxDelayMs)
    this.respawnDelay.set(app.slug, delay)
    const timer = setTimeout(() => {
      this.respawnTimers.delete(app.slug)
      const running = this.processes.get(app.slug)
      if (running !== undefined && running.ready) {
        this.respawnDelay.delete(app.slug)
        return
      }
      if (running !== undefined) return
      void this.respawnWithPortCheck(app).catch(() => undefined)
    }, delay)
    this.respawnTimers.set(app.slug, { timer, app })
  }

  private async respawnWithPortCheck(app: GatewayAppConfig): Promise<void> {
    try {
      await this.ensureInstalled(app)
    } catch (error) {
      console.error(`[apps] install of "${app.slug}" failed:`, error)
      this.scheduleRespawn(app)
      if (error instanceof InstallCommandError) throw error
      return
    }
    const desired = this.desired.get(app.slug)
    if (desired === undefined || !sameGatewayAppRuntimeConfig(desired, app)) return
    if (await portInUse(app.port)) {
      this.scheduleRespawn(app)
      return
    }
    if (this.portClaims.has(app.port)) {
      this.scheduleRespawn(app)
      return
    }
    const claim: PortClaim = { slug: app.slug }
    this.portClaims.set(app.port, claim)
    let managed: ManagedProcess | undefined
    try {
      managed = await this.spawnService(app, claim)
      await this.waitForStartup(managed)
      await this.waitForPortBinding(managed)
      managed.ready = true
    } catch (error) {
      console.error(`[apps] respawn of "${app.slug}" failed:`, error)
      if (managed !== undefined && this.processes.get(app.slug) === managed) {
        this.stopProcess(app.slug, managed)
        this.processes.delete(app.slug)
      }
      if (this.portClaims.get(app.port) === claim) this.portClaims.delete(app.port)
      this.scheduleRespawn(app)
    }
  }

  private recordReconciliationReports(
    desired: Map<string, GatewayAppConfig>,
    errors: Map<string, string>,
    observedSlugs?: ReadonlySet<string>,
  ): void {
    for (const slug of this.lastReconciliationReports.keys()) {
      if (!desired.has(slug)) this.lastReconciliationReports.delete(slug)
    }
    for (const slug of this.reconciliationReports.keys()) {
      if (!desired.has(slug)) this.reconciliationReports.delete(slug)
    }
    for (const app of desired.values()) {
      if (observedSlugs !== undefined && !observedSlugs.has(app.slug)) continue
      const error = errors.get(app.slug)
      const report: AppReconciliationReport =
        error === undefined
          ? { ...app, status: 'reconciled' }
          : {
              ...app,
              status: 'reconcile_failed',
              error: truncateUtf8(error.slice(0, 2_000), MAX_APP_RECONCILIATION_ERROR_UTF8_BYTES),
            }
      const previous = this.lastReconciliationReports.get(app.slug)
      if (previous === undefined || !sameAppReconciliationReport(previous, report)) {
        this.reconciliationReports.set(app.slug, report)
      }
      this.lastReconciliationReports.set(app.slug, report)
    }
  }

  private async waitForPortBinding(managed: ManagedProcess): Promise<void> {
    const deadline = Date.now() + this.startupBindTimeoutMs
    while (true) {
      if (
        this.processes.get(managed.app.slug) !== managed ||
        this.portClaims.get(managed.app.port) !== managed.claim
      ) {
        throw new Error(`Service "${managed.app.slug}" stopped before binding its port`)
      }
      if (await listenerOwnedByProcessTree(managed.app.port, managed.process.pid)) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(SERVICE_RETRY_INTERVAL_MS, remaining))
    }
    throw new Error(`Service "${managed.app.slug}" did not bind port ${managed.app.port}`)
  }

  private waitForStartup(managed: ManagedProcess): Promise<void> {
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        managed.process.removeListener('exit', onExit)
        managed.stderrBuffer.length = 0
        resolveWait()
      }, this.startupGraceMs)
      const onExit = (code: number | null) => {
        clearTimeout(timer)
        const stderr = managed.stderrBuffer.join('\n').slice(0, 2000)
        managed.stderrBuffer.length = 0
        reject(
          new Error(
            `Service "${managed.app.slug}" exited immediately (code=${code}).${stderr ? `\nstderr:\n${stderr}` : ''}`,
          ),
        )
      }
      managed.process.once('exit', onExit)
    })
  }

  // Cancels the scheduled retry WITHOUT forgetting how long the app has been
  // failing. The accumulated delay is the only record that this app is in a
  // crash loop; clearing it here would let any caller that sweeps through —
  // above all the vm-sync reconcile, which runs every few seconds — reset the
  // loop to full speed. Backoff is forgiven by clearRespawnBackoff only, on a
  // confirmed healthy start or when the app stops being desired.
  private cancelPendingRespawn(slug: string): void {
    const pending = this.respawnTimers.get(slug)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.respawnTimers.delete(slug)
    }
  }

  private clearRespawnBackoff(slug: string): void {
    this.cancelPendingRespawn(slug)
    this.respawnDelay.delete(slug)
  }

  private stopProcess(slug: string, managed: ManagedProcess): void {
    this.stoppingSlugs.add(slug)
    try {
      terminateService(managed.process)
    } catch {
      this.stoppingSlugs.delete(slug)
      this.releasePortClaim(managed)
    }
  }

  private releasePortClaim(managed: ManagedProcess): void {
    if (this.portClaims.get(managed.app.port) === managed.claim) {
      this.portClaims.delete(managed.app.port)
    }
  }
}

export function isRetriableProxyError(error: unknown, method: string): boolean {
  const allowAmbiguousRetry = IDEMPOTENT_METHODS.has(method.toUpperCase())
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code
    if (typeof code === 'string') {
      if (CONNECTION_NOT_ESTABLISHED_CODES.has(code)) return true
      if (allowAmbiguousRetry && AMBIGUOUS_SOCKET_ERROR_CODES.has(code)) return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function proxyTarget(request: Request): { slug: string; path: string } | null {
  const url = new URL(request.url)
  const headerSlug = request.headers.get(DUET_APP_SLUG_HEADER)
  if (headerSlug !== null && headerSlug.length > 0) {
    return { slug: headerSlug, path: stripPrefix(url.pathname, '/public/app') }
  }
  const hostSlug = appSlugFromHost(request.headers.get('host'))
  if (hostSlug !== null) return { slug: hostSlug, path: stripPrefix(url.pathname, '/public/app') }
  const parts = stripPrefix(url.pathname, '/public/app').split('/').filter(Boolean)
  const [slug, ...rest] = parts
  if (slug === undefined) return null
  return { slug, path: `/${rest.join('/')}` }
}

function appSlugFromHost(hostHeader: string | null): string | null {
  if (hostHeader === null) return null
  const host = hostHeader.split(':')[0]!.toLowerCase()
  const separator = host.indexOf('--')
  if (separator <= 0) return null
  return host.slice(0, separator)
}

function stripPrefix(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) return pathname || '/'
  const stripped = pathname.slice(prefix.length)
  return stripped.length === 0 ? '/' : stripped
}

function isEnvPath(pathname: string): boolean {
  const decoded = decodePath(pathname)
  if (decoded === null) return true
  return decoded
    .split('/')
    .filter(Boolean)
    .some(part => part === '.env' || part.startsWith('.env.'))
}

function decodePath(pathname: string): string | null {
  let value = pathname
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded: string
    try {
      decoded = decodeURIComponent(value)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    if (decoded === value) return decoded
    value = decoded
  }
  return value.includes('%') ? null : value
}

async function assertSafeCwd(driveDir: string, cwd: string): Promise<void> {
  const info = await lstat(cwd)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid app anchor path')
  const root = await realpath(driveDir)
  const resolved = await realpath(cwd)
  if (!isPathInside(root, resolved)) throw new Error('Invalid app anchor path')
}

function sameAppReconciliationReport(
  left: AppReconciliationReport,
  right: AppReconciliationReport,
): boolean {
  // Report dedup compares the prompt metadata too — a report is the exact
  // acknowledgment of the config it echoes, so a visibility/URL-only change
  // queues one fresh report. This comparator gates only re-queueing; the
  // restart and backend-acceptance comparators keep excluding metadata.
  return (
    sameGatewayAppConfig(left, right) &&
    left.visibility === right.visibility &&
    left.canonicalUrl === right.canonicalUrl &&
    left.status === right.status &&
    (left.status === 'reconciled' ||
      (right.status === 'reconcile_failed' && left.error === right.error))
  )
}

function sameDesiredAppConfigs(
  left: ReadonlyMap<string, GatewayAppConfig>,
  right: ReadonlyMap<string, GatewayAppConfig>,
): boolean {
  if (left.size !== right.size) return false
  for (const [slug, app] of left) {
    const other = right.get(slug)
    if (other === undefined || !sameGatewayAppConfig(app, other)) return false
  }
  return true
}

function sameDesiredAppConfigAtSlug(
  current: ReadonlyMap<string, GatewayAppConfig>,
  requested: ReadonlyMap<string, GatewayAppConfig>,
  slug: string,
): boolean {
  const currentApp = current.get(slug)
  const requestedApp = requested.get(slug)
  return (
    currentApp !== undefined &&
    requestedApp !== undefined &&
    sameGatewayAppConfig(currentApp, requestedApp)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// App commands often wrap the server in a shell or package-manager process.
// Own that whole group so a surviving child cannot block every later restart.
function terminateService(child: ChildProcess): void {
  const signal = (value: NodeJS.Signals) => {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, value)
        return
      } catch {}
    }
    child.kill(value)
  }
  signal('SIGTERM')
  const timer = setTimeout(() => signal('SIGKILL'), 1_000)
  timer.unref()
}

function killInstallProcess(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {}
  }
  child.kill('SIGKILL')
}

function portInUse(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolvePort(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolvePort(false)
    })
  })
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (await portInUse(port)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    await sleep(Math.min(25, remaining))
  }
}

async function listenerOwnedByProcessTree(
  port: number,
  rootPid: number | undefined,
): Promise<boolean> {
  if (rootPid === undefined) return false
  return process.platform === 'linux'
    ? await linuxListenerOwnedByProcessTree(port, rootPid)
    : await lsofListenerOwnedByProcessTree(port, rootPid)
}

async function linuxListenerOwnedByProcessTree(port: number, rootPid: number): Promise<boolean> {
  const listenerInodes = new Set<string>()
  const portHex = port.toString(16).toUpperCase().padStart(4, '0')
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const contents = await readFile(table, 'utf8').catch(() => '')
    for (const line of contents.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      const localAddress = fields[1]
      if (localAddress?.endsWith(`:${portHex}`) && fields[3] === '0A' && fields[9] !== undefined) {
        listenerInodes.add(fields[9])
      }
    }
  }
  if (listenerInodes.size === 0) return false

  const processTree = await linuxProcessTree(rootPid)
  for (const pid of processTree) {
    const descriptors = await readdir(`/proc/${pid}/fd`).catch(() => [])
    for (const descriptor of descriptors) {
      const target = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => '')
      const match = /^socket:\[(\d+)]$/.exec(target)
      if (match !== null && listenerInodes.has(match[1]!)) return true
    }
  }
  return false
}

async function linuxProcessTree(rootPid: number): Promise<Set<number>> {
  const parents = new Map<number, number>()
  const entries = await readdir('/proc', { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async entry => {
        const pid = Number(entry.name)
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
        const commandEnd = stat.lastIndexOf(')')
        if (commandEnd < 0) return
        const fields = stat.slice(commandEnd + 2).split(' ')
        const parentPid = Number(fields[1])
        if (Number.isInteger(parentPid)) parents.set(pid, parentPid)
      }),
  )
  return descendantsOf(rootPid, parents)
}

async function lsofListenerOwnedByProcessTree(port: number, rootPid: number): Promise<boolean> {
  const [lsofOutput, psOutput] = await Promise.all([
    commandOutput('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']),
    commandOutput('ps', ['-axo', 'pid=,ppid=']),
  ])
  if (lsofOutput === null || psOutput === null) return false
  const listenerPids = lsofOutput
    .split('\n')
    .filter(line => /^p\d+$/.test(line))
    .map(line => Number(line.slice(1)))
  const parents = new Map<number, number>()
  for (const line of psOutput.split('\n')) {
    const [pid, parentPid] = line.trim().split(/\s+/).map(Number)
    if (pid !== undefined && parentPid !== undefined) parents.set(pid, parentPid)
  }
  const processTree = descendantsOf(rootPid, parents)
  return listenerPids.some(pid => processTree.has(pid))
}

function descendantsOf(rootPid: number, parents: Map<number, number>): Set<number> {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parentPid] of parents) {
      if (!descendants.has(pid) && descendants.has(parentPid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  return descendants
}

function commandOutput(command: string, args: string[]): Promise<string | null> {
  return new Promise(resolveOutput => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', () => resolveOutput(null))
    child.once('exit', code => resolveOutput(code === 0 ? Buffer.concat(chunks).toString() : null))
  })
}

function requestAcceptsHtml(request: Request): boolean {
  const accept = request.headers.get('accept')
  if (accept === null) return false
  let bestSpecificity = -1
  let effectiveQuality = 0
  for (const part of accept.split(',')) {
    const [mediaType, ...parameters] = part.trim().toLowerCase().split(';')
    const qualityText = parameters
      .map(parameter => parameter.trim())
      .find(parameter => parameter.startsWith('q='))
      ?.slice(2)
    const quality = qualityText === undefined ? 1 : Number(qualityText)
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) continue
    const specificity = mediaType === 'text/html' ? 2 : mediaType === 'text/*' ? 1 : 0
    if (specificity === 0 && mediaType !== '*/*') continue
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity
      effectiveQuality = quality
    } else if (specificity === bestSpecificity) {
      effectiveQuality = Math.max(effectiveQuality, quality)
    }
  }
  return bestSpecificity >= 0 && effectiveQuality > 0
}

function canProbeBuildingFallback(
  method: string,
  path: string,
  acceptsHtml: boolean,
  upstream: 'unavailable' | { status: number },
): boolean {
  // This is only a cost gate; the policy decides again with real activity after the filesystem probe.
  if ((method !== 'GET' && method !== 'HEAD') || !acceptsHtml) return false
  return upstream === 'unavailable' || (path === '/' && upstream.status === 404)
}

function buildingResponse(
  method: string,
  app: GatewayAppConfig,
  activity: BuildActivity,
): Response {
  const html = renderBuildingPage({
    name: app.name ?? app.slug,
    files: activity.recentFiles,
    nowMs: Date.now(),
    refreshSeconds: 4,
  })
  return new Response(method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}
