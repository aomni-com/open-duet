import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

// The warm-cache boot budget, sized for a SATURATED machine rather than an idle
// one. `bun run test` has apps/api, packages/backend and this package all
// spinning their own local Convex deployments at once, and the isolation test
// starts two more. At 180s this ceiling produced a failure at almost exactly
// 180,0xx ms in four separate full runs — in three different packages, a
// different test each time — and every one of them passed in isolation. That is
// contention, not a wedge, and the fix belongs here rather than in each test's
// own budget.
const DEFAULT_READY_TIMEOUT_MS = 240_000
// One cold boot per machine downloads the dashboard bundle before it can report ready,
// and that download alone runs past the warm budget. Only that first boot gets the
// larger allowance; once the shared cache is warm, a slow boot is a wedge, not a fetch.
const COLD_DASHBOARD_READY_TIMEOUT_MS = 420_000
// Immediate-mode supervisors SIGKILL their group and exit in about a second,
// so two of these windows keep every fixture stop comfortably inside the 5s
// afterAll default. The graceful template-build stop may take ~8s; it runs off
// the afterAll path and simply spans several windows.
const DEFAULT_STOP_TIMEOUT_MS = 2_000

export interface ConvexDevOptions {
  env?: Record<string, string | undefined>
  readyTimeoutMs?: number
  reset?: boolean
  tmpDir?: string
}

export interface ConvexDevFixture {
  url: string
  siteUrl: string
  internalKey?: string
  client: ConvexHttpClient
  action(name: string, args?: Record<string, unknown>): Promise<unknown>
  mutation(name: string, args?: Record<string, unknown>): Promise<unknown>
  query(name: string, args?: Record<string, unknown>): Promise<unknown>
  clientWithAuth(token: string): ConvexHttpClient
  stop(): Promise<void>
}

export async function convexDev(
  projectDir: string,
  options: ConvexDevOptions = {},
): Promise<ConvexDevFixture> {
  const absoluteProjectDir = resolve(projectDir)
  const bootStartedAt = Date.now()
  // Live slot before any boot work, and before the boot slot inside the retry —
  // one fixed acquisition order across both pools is what makes cross-pool
  // deadlock impossible when several sessions contend.
  const liveSlot = await acquireSlot(liveSlotPool())
  const slotWaitMs = Date.now() - bootStartedAt
  let started: RunningConvex
  try {
    started = await startWithTransientRetry(absoluteProjectDir, options)
  } catch (error) {
    liveSlot.release()
    throw error
  }
  const { runtime, child, urls } = started
  // From here the slot's heartbeat is the supervisor: if bun's reaper kills
  // this file's processes without running any finally, the slot frees itself
  // the moment the supervisor pid is gone instead of staying pinned by the
  // long-lived worker pid that claimed it.
  if (child.pid !== undefined) liveSlot.restamp(child.pid)
  const readyAt = Date.now()

  try {
    await applyDeploymentEnv(runtime, options)
    await verifyClonePush(runtime, urls.url)
    profileBoot({
      slotWaitMs,
      bootMs: readyAt - bootStartedAt - slotWaitMs,
      envMs: Date.now() - readyAt,
      projectDir: absoluteProjectDir,
    })
    const client = new ConvexHttpClient(urls.url, {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
    })

    return {
      url: urls.url,
      siteUrl: urls.siteUrl,
      internalKey: options.env?.DUET_API_INTERNAL_KEY,
      client,
      action(name, args = {}) {
        return client.action(makeFunctionReference(name) as FunctionReference<'action'>, args)
      },
      mutation(name, args = {}) {
        return client.mutation(makeFunctionReference(name) as FunctionReference<'mutation'>, args)
      },
      query(name, args = {}) {
        return client.query(makeFunctionReference(name) as FunctionReference<'query'>, args)
      },
      clientWithAuth(token) {
        const authed = new ConvexHttpClient(urls.url, {
          logger: false,
          skipConvexDeploymentUrlCheck: true,
        })
        authed.setAuth(token)
        return authed
      },
      async stop() {
        try {
          await stopConvex(child)
        } finally {
          cleanupRuntime(runtime)
          liveSlot.release()
        }
      },
    }
  } catch (error) {
    try {
      await stopConvex(child)
    } finally {
      cleanupRuntime(runtime)
      liveSlot.release()
    }
    throw error
  }
}

/**
 * A template clone is only correct if its own push landed — that is what makes
 * the serving backend extract its own Node-action source instead of pointing at
 * the template builder's dead temp files. The nonce query proves it: the value
 * only exists in THIS clone's source, so reading it back is proof of push, per
 * clone, not a sample. Failing loud here beats an intermittent
 * `Cannot find module` inside some unlucky test's action call.
 */
async function verifyClonePush(runtime: ConvexDevRuntime, url: string): Promise<void> {
  if (runtime.cloneNonce === undefined) return
  const client = new ConvexHttpClient(url, { logger: false, skipConvexDeploymentUrlCheck: true })
  const served = await client.query(
    makeFunctionReference('templateCloneNonce:value') as FunctionReference<'query'>,
    {},
  )
  if (served !== runtime.cloneNonce) {
    throw new Error(
      `Template clone did not push its own source (nonce ${String(served)} != ${runtime.cloneNonce}); ` +
        'refusing to serve tests from a deployment whose Node actions may reference dead files.',
    )
  }
}

/**
 * One line per boot when DUET_CONVEX_BOOT_PROFILE names a file — the data that
 * says whether wall time is going to slot waits, the boot itself, or env
 * application, without which every speed decision here is a guess.
 */
function profileBoot(sample: {
  slotWaitMs: number
  bootMs: number
  envMs: number
  projectDir: string
}): void {
  const file = process.env.DUET_CONVEX_BOOT_PROFILE
  if (!file) return
  try {
    appendFileSync(
      file,
      `${process.pid} slotWait=${sample.slotWaitMs} boot=${sample.bootMs} env=${sample.envMs} ${sample.projectDir.split(sep).at(-1)}\n`,
    )
  } catch {
    // Profiling must never fail a boot.
  }
}

interface ConvexUrls {
  url: string
  siteUrl: string
}

interface StartedConvex {
  child: ChildProcessWithoutNullStreams
  urls: ConvexUrls
}

/**
 * Two ways a boot dies that say nothing about the deployment, both of which only
 * show up once fixtures boot alongside each other:
 *
 * - The port it was handed got taken. A port reserved by binding :0 and closing
 *   it again is only a hint until Convex binds it, so a fixture starting in
 *   another worker can win the gap and Convex exits "Requested port N is not
 *   available".
 * - Convex could not reach its version API. Every boot resolves a backend
 *   version over the network — the flag we pass covers the binary step, but the
 *   anonymous dashboard step always asks, and the CLI treats a failed fetch as
 *   fatal. Several boots asking at once is enough to lose one.
 *
 * Either takes the file's whole beforeAll with it, and either is gone on the
 * next attempt, so retry rather than fail. Anything else is a real failure and
 * propagates on the first try.
 */
const TRANSIENT_START_ATTEMPTS = 3

interface RunningConvex extends StartedConvex {
  runtime: ConvexDevRuntime
}

/**
 * Each attempt gets a fresh isolated runtime AND takes its boot slot only for
 * that attempt.
 *
 * Fresh runtime: the supervisor deletes its runtime directory when its child
 * exits — that is its whole crash-cleanup job — so after any failed attempt the
 * previous project copy is gone (or going), and respawning into it is ENOENT.
 * The copy is a few hundred milliseconds; correctness owns that cost.
 *
 * Slot per attempt: a failing boot is the worst possible slot holder — it
 * occupies the ceiling for its whole ready budget and hands nothing back — and
 * holding one slot across all retries starved other fixtures badly enough that
 * unrelated files hit their own ready timeouts. Backing off between attempts
 * also stops a version-API blip from being retried by every waiter at once.
 */
async function startWithTransientRetry(
  sourceProjectDir: string,
  options: ConvexDevOptions,
): Promise<RunningConvex> {
  const template = await ensureBootTemplate(sourceProjectDir, options)
  let lastError: unknown
  for (let attempt = 1; attempt <= TRANSIENT_START_ATTEMPTS; attempt++) {
    const runtime = await createIsolatedRuntime(sourceProjectDir, options, template)
    if (options.reset === true && template === null) {
      rmSync(join(runtime.projectDir, '.convex', 'local'), { recursive: true, force: true })
    }
    const bootSlot = await acquireSlot(bootSlotPool())
    try {
      runtime.ports = await reserveLocalPorts()
      const started = await startConvexDev(
        runtime,
        template !== null ? { ...options, readyTimeoutMs: CLONE_READY_TIMEOUT_MS } : options,
      )
      saveDashboardToSharedCache(runtime.homeDir)
      return { ...started, runtime }
    } catch (error) {
      // Idempotent alongside the supervisor's own delete of the same directory.
      cleanupRuntime(runtime)
      if (!isTransientStartFailure(error)) throw error
      lastError = error
    } finally {
      bootSlot.release()
    }
    await new Promise(backoff => setTimeout(backoff, attempt * 1_000))
  }
  throw lastError
}

/**
 * Boot templates: the first boot of a given project source pays the full
 * bundle-push-analyze cost once, gets stopped clean, and its deployment state
 * (`project/.convex` plus the deployment's private HOME) becomes a snapshot
 * that every later boot of the same source clones instead of re-deriving. A
 * cloned deployment reaches ready in a fraction of the time because `convex
 * dev` finds the push already applied.
 *
 * The cache cannot be incorrectly stale, only slower: the clone still runs a
 * real `convex dev`, which re-pushes whenever the source it sees differs from
 * what the deployment holds. A template of the wrong vintage therefore costs a
 * push, never correctness — which is why the stamp can be cheap (path, size,
 * mtime) instead of hashing file contents.
 *
 * Templates never contain test data: the snapshot is taken from a deployment
 * that was booted and stopped without ever serving a test, so `reset: true`
 * call sites get exactly the fresh state they ask for.
 *
 * Concurrency: one builder per stamp wins a pid-stamped lock; everyone else
 * polls briefly for the finished template and falls back to a normal uncached
 * boot rather than queueing behind the build. Builds land under a staging name
 * and rename in atomically, the same publish pattern as the dashboard cache.
 */
const TEMPLATE_WAIT_CEILING_MS = 45_000
const TEMPLATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface BootTemplate {
  projectConvexDir: string
  homeDir: string
}

function templatesRoot(): string {
  return join(process.env.HOME ?? tmpdir(), '.cache', 'duet-convex-templates')
}

/**
 * Identity of a project source for template reuse. Any difference re-keys the
 * template; a collision merely means the clone's own push does real work.
 */
function templateStamp(sourceProjectDir: string): string {
  const parts: string[] = [backendVersionArgs().join(' ')]
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name)
      if (!shouldCopyProjectPath(sourceProjectDir, path)) continue
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      const stat = statSync(path)
      parts.push(`${relative(sourceProjectDir, path)}:${stat.size}:${stat.mtimeMs}`)
    }
  }
  walk(sourceProjectDir)
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24)
}

/**
 * Templates pay for themselves only when the push they skip is expensive. A
 * project with a handful of Convex modules boots in a couple of seconds cold —
 * for those, the template's own overheads (build boot + stop + snapshot, and
 * the overlay copy per clone) are pure loss, and the fixture's own self-tests
 * (which kill runners mid-boot on a two-function project) stay on the simple
 * path they were written against.
 */
const TEMPLATE_MIN_CONVEX_MODULES = 10

function templateWorthwhile(sourceProjectDir: string): boolean {
  let modules = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name.endsWith('.ts')) modules++
    }
  }
  try {
    walk(join(sourceProjectDir, 'convex'))
  } catch {
    return false
  }
  return modules >= TEMPLATE_MIN_CONVEX_MODULES
}

async function ensureBootTemplate(
  sourceProjectDir: string,
  options: ConvexDevOptions,
): Promise<BootTemplate | null> {
  if (!templateWorthwhile(sourceProjectDir)) return null
  let stamp: string
  try {
    stamp = templateStamp(sourceProjectDir)
  } catch {
    return null
  }
  const root = templatesRoot()
  mkdirSync(root, { recursive: true })
  pruneStaleTemplates(root)
  const templateDir = join(root, stamp)
  const template = (): BootTemplate | null =>
    existsSync(join(templateDir, 'ready'))
      ? {
          projectConvexDir: join(templateDir, 'project-convex'),
          homeDir: join(templateDir, 'home'),
        }
      : null

  const existing = template()
  if (existing !== null) return existing

  const lock = join(root, `${stamp}.lock`)
  let holdingLock = false
  try {
    mkdirSync(lock, { recursive: false })
    writeFileSync(join(lock, 'pid'), String(process.pid))
    holdingLock = true
  } catch {
    if (!holderIsAlive(lock)) {
      rmSync(lock, { recursive: true, force: true })
      return null // Next boot retries the build; this one boots uncached.
    }
  }

  if (!holdingLock) {
    // Someone else is building: wait briefly for their result, then give up and
    // boot uncached — a template is an optimization, never a dependency.
    const deadline = Date.now() + TEMPLATE_WAIT_CEILING_MS
    while (Date.now() < deadline) {
      const built = template()
      if (built !== null) return built
      if (!existsSync(lock) || !holderIsAlive(lock)) break
      await new Promise(wait => setTimeout(wait, SLOT_POLL_MS))
    }
    return template()
  }

  try {
    const built = await buildBootTemplate(sourceProjectDir, options, templateDir)
    return built ? template() : null
  } catch {
    return null
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

async function buildBootTemplate(
  sourceProjectDir: string,
  options: ConvexDevOptions,
  templateDir: string,
): Promise<boolean> {
  const runtime = await createIsolatedRuntime(sourceProjectDir, options, null)
  // The supervisor may only delete this scoped directory on exit — the build
  // needs project/.convex and home to SURVIVE the stop so they can be
  // snapshotted; cleanupRuntime in the finally still removes everything.
  const supervisorScope = join(runtime.tempDir, 'convex-dev-supervisor-scope')
  mkdirSync(supervisorScope, { recursive: true })
  const bootSlot = await acquireSlot(bootSlotPool())
  let child: ChildProcessWithoutNullStreams | null = null
  try {
    runtime.ports = await reserveLocalPorts()
    ;({ child } = await startConvexDev(runtime, options, supervisorScope, 'graceful'))
    saveDashboardToSharedCache(runtime.homeDir)
  } catch {
    if (child !== null) await stopConvex(child)
    cleanupRuntime(runtime)
    return false
  } finally {
    bootSlot.release()
  }

  const staging = `${templateDir}.staging-${process.pid}`
  try {
    // The deployment must be fully stopped before its sqlite is copied, and
    // this stop is the graceful kind — give it the full escalation ladder
    // (SIGINT 5s, TERM 2s, KILL 1s inside the supervisor) rather than the
    // 2s-per-window budget sized for immediate-mode fixture stops.
    await stopConvex(child, 12_000)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    cpSync(join(runtime.projectDir, '.convex'), join(staging, 'project-convex'), {
      recursive: true,
    })
    cpSync(runtime.homeDir, join(staging, 'home'), {
      recursive: true,
      filter: source => !source.includes(join('.cache', 'convex', 'binaries')),
    })
    writeFileSync(join(staging, 'ready'), new Date().toISOString())
    rmSync(templateDir, { recursive: true, force: true })
    renameSync(staging, templateDir)
    return true
  } catch {
    rmSync(staging, { recursive: true, force: true })
    return false
  } finally {
    cleanupRuntime(runtime)
  }
}

function pruneStaleTemplates(root: string): void {
  try {
    for (const entry of readdirSync(root)) {
      const path = join(root, entry)
      try {
        if (Date.now() - statSync(path).mtimeMs > TEMPLATE_MAX_AGE_MS) {
          rmSync(path, { recursive: true, force: true })
        }
      } catch {}
    }
  } catch {}
}

/**
 * Every fixture boots into a fresh `HOME` with no deployment on record, which is
 * the one case where Convex resolves "the latest backend version" over the
 * network — and treats a failed fetch as fatal, so a blip kills the file's whole
 * beforeAll ("Failed to fetch latest backend version"). Pinning a version the
 * shared cache already holds takes that request off the critical path of every
 * boot, the same bargain the dashboard cache makes: the first boot on a machine
 * still pays to populate it, and nothing after it touches the network.
 *
 * The cache lays binaries out one directory per version, so the newest
 * directory name is the version to ask for.
 */
function backendVersionArgs(): string[] {
  const binaries = join(process.env.HOME ?? tmpdir(), '.cache', 'convex', 'binaries')
  let versions: string[]
  try {
    versions = readdirSync(binaries).filter(version =>
      existsSync(join(binaries, version, 'convex-local-backend')),
    )
  } catch {
    return []
  }
  const newest = versions.sort().at(-1)
  return newest === undefined ? [] : ['--local-backend-version', newest]
}

// Matched against Convex's exact phrasing, not loose substrings: the error
// carries the deployment's whole log, and anything less specific would retry a
// boot that failed for an unrelated reason that merely mentioned a port or a
// fetch.
const TRANSIENT_START_FAILURES = [
  /Requested port \d+ is not available/,
  /Failed to fetch latest backend version/,
  // The same version fetch can also STALL rather than fail — it has no timeout
  // in the CLI — and a stalled boot never prints ready. Distinguishable from a
  // slow boot only because clone boots have a short honest ceiling; a fresh
  // process makes a fresh fetch, which is why retrying works.
  /Timed out waiting for Convex local dev/,
]

// A clone is ready in a few seconds; a clone that has printed nothing for a
// minute is not slow, it is wedged on something unbounded inside the CLI.
// Three of these still fit inside every beforeAll budget with room to spare.
// Uncached and template boots keep the full saturated-machine budget.
const CLONE_READY_TIMEOUT_MS = 60_000

function isTransientStartFailure(error: unknown): boolean {
  return (
    error instanceof Error && TRANSIENT_START_FAILURES.some(pattern => pattern.test(error.message))
  )
}

function startConvexDev(
  runtime: ConvexDevRuntime,
  options: ConvexDevOptions,
  // The directory the supervisor deletes when its child exits. Normal fixtures
  // hand it the whole runtime so an abruptly killed runner leaks nothing. A
  // template build MUST NOT: its whole point is to snapshot project/.convex and
  // home after the deployment stops, and the first implementation lost every
  // snapshot to exactly this cleanup — five empty staging dirs and not one
  // published template. It passes a scoped throwaway instead.
  supervisorCleanupDir: string = runtime.tempDir,
  supervisorKillMode: 'immediate' | 'graceful' = 'immediate',
): Promise<StartedConvex> {
  const child = spawn(
    process.execPath,
    [
      convexSupervisorBin(),
      'node',
      convexCliBin(),
      'dev',
      '--typecheck',
      'disable',
      '--tail-logs',
      'disable',
      '--local-cloud-port',
      runtime.ports.cloud.toString(),
      '--local-site-port',
      runtime.ports.site.toString(),
      ...backendVersionArgs(),
    ],
    {
      cwd: runtime.projectDir,
      env: {
        ...convexEnv(runtime, options),
        DUET_CONVEX_SUPERVISOR_RUNTIME_DIR: supervisorCleanupDir,
        DUET_CONVEX_SUPERVISOR_KILL_MODE: supervisorKillMode,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const logs: string[] = []

  return new Promise<StartedConvex>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for Convex local dev to become ready.\n${logs.join('')}`))
    }, options.readyTimeoutMs ?? defaultReadyTimeoutMs())

    // A start that never becomes ready still owns a live process group, and only
    // this function has the handle — the caller receives a child on success
    // alone. Tear it down before rejecting so a retry, or a failed beforeAll,
    // cannot strand a backend holding a port and a couple of cores.
    //
    // First failure wins, explicitly: tearing down after a ready-timeout makes
    // the child exit, and that exit's own fail() call would otherwise race the
    // deferred timeout rejection and win — reclassifying a retryable timeout
    // as a terminal "exited before ready" and defeating the transient retry.
    let rootFailure: Error | null = null
    const fail = (error: Error) => {
      if (rootFailure === null) rootFailure = error
      clearTimeout(timeout)
      void stopConvex(child)
        .catch(() => undefined)
        .then(() => rejectReady(rootFailure ?? error))
    }

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      logs.push(text)
      if (text.includes('✖ Error') || text.includes('[ERROR]')) {
        fail(new Error(`Convex local dev failed to deploy.\n${logs.join('')}`))
        return
      }
      if (!text.includes('Convex functions ready')) return
      const urls = readConvexUrls(runtime.projectDir)
      if (urls.url === null || urls.siteUrl === null) {
        fail(
          new Error(
            `Convex reported ready but did not write CONVEX_URL and CONVEX_SITE_URL.\n${logs.join('')}`,
          ),
        )
        return
      }
      clearTimeout(timeout)
      resolveReady({ child, urls: { url: urls.url, siteUrl: urls.siteUrl } })
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      fail(
        new Error(
          `Convex local dev exited before ready (code ${code}, signal ${signal}).\n${logs.join('')}`,
        ),
      )
    })
  })
}

/**
 * Where deployments live. Everything under a runtime is disposable, and its
 * write pattern is sqlite commits — on macOS each one pays F_FULLFSYNC, which
 * is slow enough (5-15ms) to dominate mutation-heavy suites. A RAM-backed
 * volume makes those commits nearly free, so if one is mounted (or a path is
 * named explicitly), deployments go there. Absent both, the system tmpdir.
 */
function fixtureTmpRoot(): string {
  const configured = process.env.DUET_CONVEX_FIXTURE_TMPDIR
  if (configured !== undefined && configured !== '' && existsSync(configured)) return configured
  const ramDisk = '/Volumes/DuetTestRam'
  if (existsSync(ramDisk)) return ramDisk
  return tmpdir()
}

interface ConvexDevRuntime {
  projectDir: string
  tempDir: string
  homeDir: string
  // Set only for template clones: the value the deployment's own
  // templateCloneNonce query must return once this clone's push has landed.
  cloneNonce?: string
  ports: {
    cloud: number
    site: number
  }
}

async function createIsolatedRuntime(
  sourceProjectDir: string,
  options: ConvexDevOptions,
  template: BootTemplate | null,
): Promise<ConvexDevRuntime> {
  const tempRoot = options.tmpDir ?? fixtureTmpRoot()
  mkdirSync(tempRoot, { recursive: true })
  const tempDir = mkdtempSync(join(tempRoot, 'convex-dev-'))
  try {
    const projectDir = join(tempDir, 'project')
    const homeDir = join(tempDir, 'home')
    let cloneNonce: string | undefined
    mkdirSync(projectDir)
    mkdirSync(homeDir)
    linkSharedConvexCaches(homeDir)
    copyProjectSource(sourceProjectDir, projectDir)
    symlinkNodeModules(sourceProjectDir, projectDir)
    if (template !== null) {
      // Overlay the template's already-pushed deployment: `.convex` into the
      // project copy, the deployment's private HOME state on top of the fresh
      // one. The binaries symlink from linkSharedConvexCaches stays; the
      // template never contains one (filtered out at snapshot).
      cpSync(template.projectConvexDir, join(projectDir, '.convex'), { recursive: true })
      cpSync(template.homeDir, homeDir, { recursive: true, force: true })
      // A clone must always REALLY push, so its own backend extracts its own
      // Node-action source. A hash-matching no-op push leaves the clone serving
      // "use node" actions from source files recorded by the TEMPLATE's dead
      // backend under its temp dir — present or absent by luck, which showed up
      // as intermittent `Cannot find module '.../.tmpXXXX/source/...'` failures
      // in every project with Node actions. The nonce module re-keys the source
      // hash per clone; what the template still buys is the deployment's
      // schema, index, and storage initialization.
      //
      // The nonce is a QUERY so the boot can prove the push happened: after
      // env application the fixture reads it back and requires its own value.
      // Six green sample runs are ~67% evidence; the readback is proof, every
      // clone, forever.
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      writeFileSync(
        join(projectDir, 'convex', 'templateCloneNonce.ts'),
        [
          `import { query } from './_generated/server'`,
          '',
          '// Written per clone by the test harness; never part of the real backend.',
          `export const value = query({ handler: () => '${nonce}' })`,
          '',
        ].join('\n'),
      )
      cloneNonce = nonce
    }
    // Ports are claimed per start attempt, not here: a reservation made before
    // the project copy would sit unbound for that whole copy, widening the
    // window in which another worker can take it.
    return { projectDir, tempDir, homeDir, cloneNonce, ports: { cloud: 0, site: 0 } }
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

function copyProjectSource(sourceProjectDir: string, targetProjectDir: string): void {
  cpSync(sourceProjectDir, targetProjectDir, {
    recursive: true,
    filter: sourcePath => shouldCopyProjectPath(sourceProjectDir, sourcePath),
  })
}

function shouldCopyProjectPath(sourceProjectDir: string, sourcePath: string): boolean {
  const path = relative(sourceProjectDir, sourcePath)
  if (path === '') return true
  const [topLevel] = path.split(sep)
  if (topLevel === undefined) return true
  if (topLevel.startsWith('.env')) return false
  return !new Set(['.convex', '.turbo', 'dist', 'node_modules']).has(topLevel)
}

function symlinkNodeModules(sourceProjectDir: string, targetProjectDir: string): void {
  const nodeModules = findNodeModules(sourceProjectDir)
  if (nodeModules === null) return
  symlinkSync(nodeModules, join(targetProjectDir, 'node_modules'), 'dir')
}

export function sharedDashboardCacheDir(): string {
  return join(process.env.HOME ?? tmpdir(), '.cache', 'convex', 'dashboard')
}

function isPopulatedDashboardCache(dir: string): boolean {
  return existsSync(join(dir, 'config.json'))
}

/** The bundle's own vintage, as the CLI records it; null when it cannot be read. */
function dashboardVersion(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) return null
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function defaultReadyTimeoutMs(): number {
  return isPopulatedDashboardCache(sharedDashboardCacheDir())
    ? DEFAULT_READY_TIMEOUT_MS
    : COLD_DASHBOARD_READY_TIMEOUT_MS
}

/**
 * Publishes a downloaded bundle so later fixtures skip the download. A shared copy
 * of another vintage is replaced, not kept: the CLI matches the bundle to the
 * backend binary and re-downloads on any mismatch, so a stale shared copy seeds
 * every fresh boot with a fetch it must then repeat — the fetch that fails outright
 * when GitHub is unreachable. Staging into a pid-scoped directory and renaming keeps
 * a half-copied bundle from ever being visible as the shared cache; losing the
 * rename to a concurrent fixture is a no-op.
 */
export function saveDashboardToSharedCache(
  homeDir: string,
  shared: string = sharedDashboardCacheDir(),
): void {
  const downloaded = join(homeDir, '.cache', 'convex', 'dashboard')
  if (!isPopulatedDashboardCache(downloaded)) return
  if (
    isPopulatedDashboardCache(shared) &&
    dashboardVersion(shared) === dashboardVersion(downloaded)
  ) {
    return
  }
  const staging = `${shared}.${process.pid}.tmp`
  try {
    rmSync(staging, { recursive: true, force: true })
    cpSync(downloaded, staging, { recursive: true })
    rmSync(shared, { recursive: true, force: true })
    renameSync(staging, shared)
  } catch {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Seeds an isolated HOME from the shared caches. Binaries are symlinked because the CLI
 * only ever adds to that directory. The dashboard bundle must be copied instead: the CLI
 * rmdir's and recreates its directory when refreshing, and rmdir on a symlink fails with
 * ENOTDIR, taking the whole boot down.
 */
function linkSharedConvexCaches(homeDir: string): void {
  const sharedHome = process.env.HOME
  if (sharedHome === undefined) return
  const sharedBinaries = join(sharedHome, '.cache', 'convex', 'binaries')
  mkdirSync(sharedBinaries, { recursive: true })
  const localConvexCache = join(homeDir, '.cache', 'convex')
  mkdirSync(localConvexCache, { recursive: true })
  symlinkSync(sharedBinaries, join(localConvexCache, 'binaries'), 'dir')
  const sharedDashboard = sharedDashboardCacheDir()
  if (isPopulatedDashboardCache(sharedDashboard)) {
    cpSync(sharedDashboard, join(localConvexCache, 'dashboard'), { recursive: true })
  }
}

/**
 * Booting is what saturates the machine, not serving. Bundling and pushing the
 * Convex directory costs roughly two and a half cores for the length of a boot,
 * while a deployment that is already answering queries costs a fraction of that
 * — so the resource worth rationing is boots in flight, and only boots.
 *
 * No per-package setting can ration it. `turbo` runs the Convex-backed packages
 * against each other and each runs its files N wide, so the two concurrencies
 * multiply, and nothing in either layer knows what the other is doing. Past the
 * machine's ceiling every boot slows down together until some of them trip their
 * own ready budget, which reads as a wedged deployment and is only contention.
 *
 * So the ceiling lives here, and it is machine-wide: a slot directory whose
 * atomic `mkdir` is the lock, shared by every process on the box. Widths above
 * stay free to describe how much *test* work should overlap, which is the thing
 * they are actually good at expressing.
 *
 * Slots are released the moment a deployment reports ready, not when the fixture
 * stops — holding one for the life of a test file would serialize the suite
 * rather than its boots.
 */
const SLOT_POLL_MS = 250
// A claimant that cannot get a slot within this window proceeds anyway — the
// pools are brakes, never walls. The ceiling is deliberately SHORT: a healthy
// run measures near-zero slot wait, so a long wait only ever means leaked
// slots, and a boot that waits politely for the full ceiling converts someone
// else's leak into its own beforeAll death. These waits can stack (live slot,
// template wait, boot slot); their sum must stay well inside the 240s boot
// budget with room for the boot itself.
const SLOT_WAIT_CEILING_MS = 30_000

interface SlotPool {
  name: string
  count: number
}

/**
 * The boot pool: held from spawn to ready. Booting bundles and pushes the whole
 * Convex directory at a couple of cores per boot, and the machine still has to
 * run the tests those boots exist for; a third of the cores keeps boots off each
 * other's backs without idling the box.
 */
function bootSlotPool(): SlotPool {
  const configured = Number(process.env.DUET_CONVEX_BOOT_SLOTS)
  return {
    name: 'duet-convex-boot-slots',
    count:
      Number.isInteger(configured) && configured > 0
        ? configured
        : Math.max(2, Math.min(6, Math.round(cpus().length / 3))),
  }
}

/**
 * The live pool: held from ready until the fixture stops. Serving is cheaper
 * than booting but not free, and nothing else bounds how many deployments the
 * whole MACHINE keeps alive — turbo multiplies package concurrency by width,
 * and parallel agent sessions multiply that again. Half the cores leaves the
 * other half for the tests driving those deployments.
 */
function liveSlotPool(): SlotPool {
  const configured = Number(process.env.DUET_CONVEX_LIVE_SLOTS)
  return {
    name: 'duet-convex-live-slots',
    count:
      Number.isInteger(configured) && configured > 0
        ? configured
        : // One per core. Serving proved nearly free — 0.1ms localhost round
          // trips; the suites are dominated by their own sleeps and polls —
          // so a live deployment mostly idles, and earlier tighter caps
          // (cores/2, then 2/3) throttled healthy gates below their hardware
          // while the real CPU events are 3s boot bursts, which the boot pool
          // already rations. This cap exists for cross-session pile-ups, not
          // steady state.
          Math.max(8, Math.min(20, cpus().length)),
  }
}

/**
 * A holder that died — killed runner, crashed worker, `bun test --parallel`
 * reaping a file — leaves its directory behind, so a slot is reclaimable exactly
 * when the pid it names is gone. Reclaiming races another reclaimer harmlessly:
 * both remove, one wins the re-create.
 */
function claimSlot(pool: SlotPool, index: number): string | null {
  const slot = join(tmpdir(), pool.name, `slot-${index}`)
  try {
    mkdirSync(slot, { recursive: false })
    writeFileSync(join(slot, 'pid'), String(process.pid))
    return slot
  } catch {
    if (!holderIsAlive(slot)) {
      rmSync(slot, { recursive: true, force: true })
    }
    return null
  }
}

function holderIsAlive(slot: string): boolean {
  let pid: number
  try {
    pid = Number(readFileSync(join(slot, 'pid'), 'utf-8').trim())
  } catch {
    // Claimed but not yet stamped: assume alive so a slot mid-claim is not stolen.
    return true
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface HeldSlot {
  release(): void
  /**
   * Re-stamp the slot with the pid whose death should free it. The claiming
   * process's own pid is the wrong liveness signal for anything held across a
   * test file's life: bun's --isolate reaper SIGKILLs a file's leftover
   * processes without running finallys, and the worker process itself lives on
   * — leaving a slot pinned by a healthy pid that will never release it. The
   * deployment's supervisor dies exactly when the deployment does, reaper
   * included, so its pid is the honest heartbeat.
   */
  restamp(pid: number): void
}

async function acquireSlot(pool: SlotPool): Promise<HeldSlot> {
  mkdirSync(join(tmpdir(), pool.name), { recursive: true })
  const deadline = Date.now() + SLOT_WAIT_CEILING_MS
  let held: string | null = null
  while (held === null && Date.now() < deadline) {
    // Start the sweep at a different slot per process so a queue of waiters does
    // not pile onto slot-0 and hand every race to the same winner.
    const offset = process.pid % pool.count
    for (let step = 0; step < pool.count && held === null; step++) {
      held = claimSlot(pool, (offset + step) % pool.count)
    }
    if (held === null) await new Promise(wait => setTimeout(wait, SLOT_POLL_MS))
  }

  const slot = held
  let released = false
  return {
    release() {
      if (released) return
      released = true
      if (slot !== null) rmSync(slot, { recursive: true, force: true })
    },
    restamp(pid: number) {
      if (released || slot === null) return
      try {
        writeFileSync(join(slot, 'pid'), String(pid))
      } catch {}
    },
  }
}

function findNodeModules(startDir: string): string | null {
  let current = resolve(startDir)
  while (true) {
    const candidate = join(current, 'node_modules')
    // Bun workspaces may leave a sparse package-local node_modules directory
    // before the hoisted dependency root. The isolated project needs the
    // directory that actually owns Convex, not merely the first directory
    // named node_modules on the walk upward.
    if (existsSync(join(candidate, 'convex', 'package.json'))) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function reserveLocalPorts(): Promise<{ cloud: number; site: number }> {
  const cloud = await reserveLocalPort()
  let site = await reserveLocalPort()
  while (site === cloud) site = await reserveLocalPort()
  return { cloud, site }
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error) {
          rejectPort(error)
          return
        }
        if (address === null || typeof address === 'string') {
          rejectPort(new Error('Failed to reserve local Convex port.'))
          return
        }
        resolvePort(address.port)
      })
    })
  })
}

function cleanupRuntime(runtime: ConvexDevRuntime): void {
  rmSync(runtime.tempDir, { recursive: true, force: true })
}

async function applyDeploymentEnv(
  runtime: ConvexDevRuntime,
  options: ConvexDevOptions,
): Promise<void> {
  const entries = Object.entries(deploymentEnv(options.env)).filter(
    (entry): entry is [string, string] => {
      const [, value] = entry
      return value !== undefined
    },
  )
  if (entries.length === 0) return
  // One `env set --from-file --force` instead of one CLI spawn per variable:
  // the CLI batches the whole file into a single update call, so ~10 Node cold
  // starts on every boot's critical path collapse into one, and a single write
  // cannot lose the OptimisticConcurrencyControl race that doomed parallel
  // per-var writes. Values go in single-quoted — dotenv treats those as literal,
  // which round-trips JSON (JWKS) and the space-joined PEM exactly, where
  // double-quoting corrupted them (dotenv does not unescape \" or \\). The
  // CLI-managed names it skips (CONVEX_URL/CONVEX_SITE_URL and friends) are
  // none of ours — SITE_URL itself is not on that list.
  //
  // A value a single-quoted dotenv line cannot carry (embedded quote or
  // newline) falls back to one `env set` spawn for just that variable.
  const quotable = entries.filter(([, value]) => isSingleQuotable(value))
  const awkward = entries.filter(([, value]) => !isSingleQuotable(value))
  if (quotable.length > 0) {
    const envFile = join(runtime.tempDir, 'deployment-env.dotenv')
    writeFileSync(envFile, quotable.map(([name, value]) => `${name}='${value}'`).join('\n'))
    try {
      await runConvexEnvSetFromFile(runtime, options, envFile, quotable)
    } finally {
      rmSync(envFile, { force: true })
    }
  }
  // Serial, never parallel: concurrent writes to the deployment-env document
  // 503 with OptimisticConcurrencyControl and the CLI does not retry.
  for (const [name, value] of awkward) {
    await runConvexEnvSet(runtime, options, name, value)
  }
}

function isSingleQuotable(value: string): boolean {
  return !value.includes("'") && !value.includes('\n') && !value.includes('\r')
}

function runConvexEnvSetFromFile(
  runtime: ConvexDevRuntime,
  options: ConvexDevOptions,
  envFile: string,
  entries: Array<[string, string]>,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', [convexCliBin(), 'env', 'set', '--from-file', envFile, '--force'], {
      cwd: runtime.projectDir,
      env: convexEnv(runtime, options),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logs: string[] = []
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf-8')))
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf-8')))
    child.once('error', rejectRun)
    child.once('exit', code => {
      if (code === 0) {
        resolveRun()
        return
      }
      const redacted = entries.reduce((text, [, value]) => redact(value, text), logs.join(''))
      rejectRun(new Error(`Failed to set Convex env vars from file (exit ${code}).\n${redacted}`))
    })
  })
}

function runConvexEnvSet(
  runtime: ConvexDevRuntime,
  options: ConvexDevOptions,
  name: string,
  value: string,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', [convexCliBin(), 'env', 'set', '--', name, value], {
      cwd: runtime.projectDir,
      env: convexEnv(runtime, options),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logs: string[] = []
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf-8')))
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf-8')))
    child.once('error', rejectRun)
    child.once('exit', code => {
      if (code === 0) {
        resolveRun()
        return
      }
      rejectRun(
        new Error(
          `Failed to set Convex env var ${name} (exit ${code}).\n${redact(value, logs.join(''))}`,
        ),
      )
    })
  })
}

function redact(secret: string, text: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

function convexCliBin(): string {
  const require = createRequire(import.meta.url)
  const packageJson = require.resolve('convex/package.json')
  return join(dirname(packageJson), 'bin/main.js')
}

function convexSupervisorBin(): string {
  return fileURLToPath(new URL('./convex-dev-supervisor.mjs', import.meta.url))
}

function convexEnv(runtime: ConvexDevRuntime, options: ConvexDevOptions): NodeJS.ProcessEnv {
  mkdirSync(runtime.homeDir, { recursive: true })
  const env = { ...process.env }
  delete env.CONVEX_DEPLOYMENT
  delete env.CONVEX_SELF_HOSTED_URL
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY
  delete env.CONVEX_DEPLOY_KEY
  Object.assign(env, deploymentEnv(options.env))
  env.CONVEX_AGENT_MODE = 'anonymous'
  env.CONVEX_TMPDIR = options.tmpDir ?? fixtureTmpRoot()
  // The backend extracts Node-action source into a `.tmp*` dir under plain
  // TMPDIR and only removes it on GRACEFUL exit — and fixture stops are
  // SIGKILL by design. Left at the system tmpdir this leaked one directory per
  // boot forever (16,938 of them once filled the machine's disk to 100%,
  // which surfaced as gateway file writes failing with 507). Inside the
  // runtime dir, cleanupRuntime and the supervisor wipe it on every path,
  // kills included.
  env.TMPDIR = runtime.tempDir
  env.HOME = runtime.homeDir
  env.XDG_CACHE_HOME = join(runtime.homeDir, '.cache')
  env.XDG_CONFIG_HOME = join(runtime.homeDir, '.config')
  env.XDG_STATE_HOME = join(runtime.homeDir, '.local', 'state')
  return env
}

function deploymentEnv(
  configured: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const env = { ...configured }
  // Duet signup admits a VM image synchronously. Metadata-only fixtures still
  // need a destination even when no exe.dev provider runs behind their actions.
  if (env.DUET_API_INTERNAL_KEY && !Object.hasOwn(env, 'DUET_VM_IMAGE_REF')) {
    env.DUET_VM_IMAGE_REF = 'ttl.sh/duet-test-fixture:1h'
  }
  // @convex-dev/auth requires this fixed vendor key for redirect construction.
  // Duet owns the value through DUET_APP_URL; tests mirror the production
  // secrets fan-out without making application code read the vendor alias.
  if (env.SITE_URL === undefined && env.DUET_APP_URL !== undefined) {
    env.SITE_URL = env.DUET_APP_URL
  }
  return env
}

function readConvexUrls(projectDir: string): { url: string | null; siteUrl: string | null } {
  const envPath = join(projectDir, '.env.local')
  let text: string
  try {
    text = readFileSync(envPath, 'utf-8')
  } catch {
    return { url: null, siteUrl: null }
  }
  let url: string | null = null
  let siteUrl: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const convexUrl = line.match(/^CONVEX_URL=(.*)$/)
    if (convexUrl) url = convexUrl[1]?.trim().replace(/^['"]|['"]$/g, '') || null
    const convexSiteUrl = line.match(/^CONVEX_SITE_URL=(.*)$/)
    if (convexSiteUrl) siteUrl = convexSiteUrl[1]?.trim().replace(/^['"]|['"]$/g, '') || null
  }
  return { url, siteUrl }
}

async function stopConvex(
  child: ChildProcess,
  timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  const stopped = await waitForExit(child, timeoutMs)
  if (stopped) return
  child.kill('SIGTERM')
  await waitForExit(child, timeoutMs)
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolveWait => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveWait(true)
      return
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolveWait(false)
    }, timeoutMs)
    const onExit = () => {
      cleanup()
      resolveWait(true)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}
