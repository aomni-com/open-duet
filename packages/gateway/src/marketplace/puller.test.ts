import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import {
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  type VmDesiredMarketplaceAgents,
} from '@repo/contract'

import { createPublishesRoutes } from '../routes/publishes'
import { createMarketplaceAgentPuller, type MarketplaceAgentTimerKind } from './puller'

/**
 * Enough fake time for a converge timer to be genuinely due. Comfortably past
 * the half-hour-ish interval without pinning its exact value, so retuning the
 * cadence does not rewrite these tests.
 */
const CONVERGE_COMES_DUE_MS = 60 * 60 * 1_000

let root: string
let hubDriveDir: string
let subscriberDriveDir: string
let subscriberStateDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-official-agent-puller-'))
  hubDriveDir = join(root, 'hub-drive')
  subscriberDriveDir = join(root, 'subscriber-drive')
  subscriberStateDir = join(root, 'subscriber-state')
  await Promise.all([
    mkdir(join(hubDriveDir, 'official-agents', 'research-assistant'), { recursive: true }),
    mkdir(subscriberDriveDir, { recursive: true }),
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('marketplace puller', () => {
  // The exact shape of a real report: an app un-shipped by its publisher left a
  // folder holding nothing but its `node_modules`. Dependencies are installed on
  // this VM, so they are in no manifest, which made them indistinguishable from
  // the user's own additions to the rule that keeps local work — and the folder
  // stayed forever because it was never empty.
  test('an un-shipped app takes its installed dependencies with it', async () => {
    const appDir = join(hubDriveDir, 'official-agents', 'research-assistant', 'apps', 'board')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'server.ts'), 'export {}\n')
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      '# Research assistant\n',
    )
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    await puller.pullNow()

    // Installed here, by the app's own install step. Nothing upstream knows it.
    const installedAppDir = join(
      subscriberDriveDir,
      'agents',
      'research-assistant',
      'apps',
      'board',
    )
    await mkdir(join(installedAppDir, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(
      join(installedAppDir, 'node_modules', 'left-pad', 'index.js'),
      'module.exports\n',
    )

    // The publisher deletes the app.
    await rm(join(hubDriveDir, 'official-agents', 'research-assistant', 'apps'), {
      recursive: true,
    })
    await puller.pullNow()
    expect(await readdir(join(subscriberDriveDir, 'agents', 'research-assistant'))).not.toContain(
      'apps',
    )
  })

  // The other half of the same rule: a live app keeps what it installed.
  test('a still-shipped app keeps its installed dependencies', async () => {
    const appDir = join(hubDriveDir, 'official-agents', 'research-assistant', 'apps', 'board')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'server.ts'), 'export {}\n')
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    await puller.pullNow()
    const installedAppDir = join(
      subscriberDriveDir,
      'agents',
      'research-assistant',
      'apps',
      'board',
    )
    await mkdir(join(installedAppDir, 'node_modules'), { recursive: true })
    await writeFile(join(installedAppDir, 'node_modules', 'marker.txt'), 'installed\n')

    // A content change, not a removal.
    await writeFile(join(appDir, 'server.ts'), 'export const changed = true\n')
    await puller.pullNow()

    expect(await readdir(join(installedAppDir, 'node_modules'))).toEqual(['marker.txt'])
  })

  test('downloads a real published agent and materializes its files', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      '# Research assistant\n',
    )
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'active',
        appliedEtag: expect.any(String),
        lastAppliedAt: expect.any(Number),
      },
    ])
    expect(
      await readFile(join(subscriberDriveDir, 'agents', 'research-assistant', 'AGENTS.md'), 'utf8'),
    ).toBe('# Research assistant\n')
    expect(fixture.requests).toEqual([
      {
        url: 'https://edge-staging.duet.so/hub-workspace/official-agents/research-assistant?zip',
        ifNoneMatch: null,
      },
    ])
    const persisted = JSON.parse(
      await readFile(join(subscriberStateDir, 'marketplace-subscriptions.json'), 'utf8'),
    ) as Array<{ etag?: string; manifest: { files: Record<string, unknown> } }>
    expect(persisted[0]).toMatchObject({
      etag: expect.any(String),
      manifest: { files: { 'AGENTS.md': expect.any(Object) } },
    })
    expect(
      (await readFile(join(subscriberStateDir, 'marketplace', 'subscription-1', 'snapshot.zip')))
        .byteLength,
    ).toBeGreaterThan(0)
  })

  test('sends If-None-Match and reapplies the cached snapshot on 304', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'upstream',
    )
    const fixture = createHubFixture()
    const applied: string[] = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      postApply: result => void applied.push(result.etag),
    })
    await puller.accept(desired())
    const [first] = await puller.pullNow()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await rm(join(target, 'AGENTS.md'))
    await writeFile(join(target, 'mine.txt'), 'local addition')

    const [second] = await puller.pullNow()

    expect(first?.state).toBe('active')
    if (first?.state !== 'active') throw new Error('first pull did not apply')
    expect(second).toMatchObject({ state: 'active', appliedEtag: first.appliedEtag })
    expect(fixture.requests[1]?.ifNoneMatch).toBe(first.appliedEtag)
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('upstream')
    expect(await readFile(join(target, 'mine.txt'), 'utf8')).toBe('local addition')
    expect(applied).toEqual([first.appliedEtag, first.appliedEtag])
  })

  // `active` means the agent's files landed. Bringing its apps up is the
  // supervisor's job and has its own status; a cold VM installing three
  // picks' apps in series must not hold every report — and every later pull —
  // behind it, and an app that fails to boot is the app's error, not the
  // install's.
  test('reports active as soon as files land, without waiting on postApply', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'upstream',
    )
    const fixture = createHubFixture()
    let releaseApps!: () => void
    const appsReady = new Promise<void>(resolve => {
      releaseApps = resolve
    })
    const seen: string[] = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      postApply: async result => {
        seen.push(result.etag)
        await appsReady
      },
    })
    await puller.accept(desired())

    const outcome = await Promise.race([
      puller.pullNow(),
      Bun.sleep(1_000).then(() => 'still waiting on postApply' as const),
    ])

    expect(outcome).not.toBe('still waiting on postApply')
    if (typeof outcome === 'string') throw new Error(outcome)
    const [report] = outcome
    expect(report).toMatchObject({ state: 'active' })
    if (report?.state !== 'active') throw new Error('pull did not apply')
    expect(seen).toEqual([report.appliedEtag])
    releaseApps()
  })

  test('an app that fails to come up is not an install failure', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'upstream',
    )
    const fixture = createHubFixture()
    const logged: Array<Record<string, unknown>> = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      postApply: async () => {
        throw new Error('App "board" did not become ready')
      },
      log: fields => void logged.push(fields),
    })
    await puller.accept(desired())

    const [report] = await puller.pullNow()
    // The detached reconcile settles on its own tick.
    await Bun.sleep(10)

    expect(report).toMatchObject({ state: 'active' })
    expect(
      logged.some(
        entry =>
          entry.operation === 'marketplace_post_apply' &&
          entry.status === 'failed' &&
          String(entry.error).includes('did not become ready'),
      ),
    ).toBe(true)
  })

  test('applies an upstream change without deleting local additions', async () => {
    const upstream = join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md')
    await writeFile(upstream, 'v1')
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    const [first] = await puller.pullNow()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await writeFile(join(target, 'mine.txt'), 'local')
    await writeFile(upstream, 'version two')

    const [second] = await puller.pullNow()

    expect(first?.state).toBe('active')
    expect(second?.state).toBe('active')
    if (first?.state !== 'active' || second?.state !== 'active') {
      throw new Error('upstream pulls did not apply')
    }
    expect(second.appliedEtag).not.toBe(first.appliedEtag)
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('version two')
    expect(await readFile(join(target, 'mine.txt'), 'utf8')).toBe('local')
  })

  test('retains cached state across an offline failure and retries successfully', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'cached',
    )
    const fixture = createHubFixture()
    let offline = false
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async (input, init) => {
        if (offline) throw new Error('offline')
        return fixture.fetch(input, init)
      },
    })
    await puller.accept(desired())
    const [first] = await puller.pullNow()
    offline = true

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'pull_failed',
        observedAt: expect.any(Number),
      },
    ])
    offline = false
    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'active',
        appliedEtag: first?.state === 'active' ? first.appliedEtag : '',
        lastAppliedAt: expect.any(Number),
      },
    ])
  })

  test('logs the original exception without changing the stable pull report', async () => {
    const logs: Array<Record<string, unknown>> = []
    const exception = Object.assign(
      new Error("EXDEV: cross-device link not permitted, link '/state/install' -> '/drive/agent'"),
      {
        code: 'EXDEV',
        errno: -18,
        syscall: 'link',
        path: '/state/install',
        dest: '/drive/agent',
      },
    )
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () => {
        throw exception
      },
      log: fields => logs.push(fields),
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'pull_failed',
        observedAt: expect.any(Number),
      },
    ])
    expect(logs).toEqual([
      {
        operation: 'marketplace_pull',
        subscriptionId: 'subscription-1',
        status: 'failed',
        error: 'pull_failed',
        retryable: true,
        stage: 'fetch_archive',
        exception,
      },
    ])
  })

  test('identifies a materialization failure in the diagnostic log', async () => {
    const logs: Array<Record<string, unknown>> = []
    await mkdir(join(subscriberDriveDir, 'agents'), { recursive: true })
    await writeFile(join(subscriberDriveDir, 'agents', 'research-assistant'), 'path collision')
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: createHubFixture().fetch,
      log: fields => logs.push(fields),
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'pull_failed',
        observedAt: expect.any(Number),
      },
    ])
    expect(logs).toEqual([
      expect.objectContaining({
        operation: 'marketplace_pull',
        subscriptionId: 'subscription-1',
        stage: 'materialize_files',
        exception: expect.any(Error),
      }),
    ])
    expect((logs[0]!.exception as Error).message).toBe(
      'Official-agent materializer target must be a directory',
    )
  })

  test('repairs tampered upstream content from a 304 snapshot and preserves the edit', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    await puller.pullNow()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await writeFile(join(target, 'AGENTS.md'), 'my edit')

    await puller.pullNow()

    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('official')
    const conflict = (await readdir(target)).find(name => name.includes('.sync-conflict-'))
    expect(conflict).toBeDefined()
    expect(await readFile(join(target, conflict!), 'utf8')).toBe('my edit')
  })

  test('falls back conservatively when the cached archive is lost', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    await puller.pullNow()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await writeFile(join(target, 'AGENTS.md'), 'local divergence')
    await rm(join(subscriberStateDir, 'marketplace', 'subscription-1', 'snapshot.zip'))

    await puller.pullNow()

    expect(fixture.requests[1]?.ifNoneMatch).toBeNull()
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('official')
    const conflict = (await readdir(target)).find(name => name.includes('.sync-conflict-'))
    expect(await readFile(join(target, conflict!), 'utf8')).toBe('local divergence')
  })

  // The whole point of the split: repairing the drive reads the snapshot already
  // on disk, so it has never needed the internet. A repair pass that opens a
  // socket is the old fused poll wearing a new name, and `fixture.requests` is
  // the outermost seam that can tell the difference honestly.
  test('a convergence pass repairs the drive with no network at all', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await rm(join(target, 'AGENTS.md'))
    const requestsBefore = fixture.requests.length

    currentTime += CONVERGE_COMES_DUE_MS
    await timers.fire('converge')

    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('official')
    expect(fixture.requests).toHaveLength(requestsBefore)
  })

  // THE GATE. Everything above this point still asks the origin every half
  // hour; this is where the fleet stops paying an edge resolve to be told
  // nothing changed. `fixture.requests` is again the only honest witness.
  test('a subscription already at the projected revision stretches to the gated interval', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(stamped('press-1'))
    await puller.pullNow()
    puller.start()
    // The sync re-delivers the same token the pull just landed on — the ordinary
    // steady state, arriving every five seconds forever.
    await puller.accept(stamped('press-1'))
    const requestsBefore = fixture.requests.length

    // The projected twelve hours, not merely "longer than the old half hour":
    // a regression to a ninety-minute gate would pass the weaker assertion.
    const [revalidate] = timers.pending('revalidate')
    expect(revalidate?.delayMs).toBeGreaterThan(10 * 60 * 60 * 1_000)
    currentTime += CONVERGE_COMES_DUE_MS
    await timers.fire('converge')

    // Local repair still runs on its own clock; the network is simply not asked.
    expect(fixture.requests).toHaveLength(requestsBefore)
  })

  // The projection is a LEVEL: the same revision arrives every five seconds,
  // forever. Re-acting on each delivery would push the directed pull's timer out
  // by five seconds every five seconds — a fetch that is always about to happen
  // and never does. The trigger therefore fires once per distinct VALUE, and
  // re-delivery must leave the pending timer untouched (the fixture's timer id
  // only survives if nothing rescheduled it).
  test('re-delivering the same revision does not push its directed pull out again', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    const requestsBefore = fixture.requests.length

    await puller.accept(stamped('press-2'))
    const [triggered] = timers.pending('revalidate')
    expect(triggered).toBeDefined()

    // Nine more syncs carrying the same token — the ordinary steady state.
    for (let tick = 0; tick < 9; tick += 1) await puller.accept(stamped('press-2'))

    expect(timers.pending('revalidate')).toEqual([triggered!])
    expect(fixture.requests).toHaveLength(requestsBefore)

    // And it still costs exactly one fetch when it finally comes due.
    await timers.fire('revalidate')
    expect(fixture.requests).toHaveLength(requestsBefore + 1)
  })

  test('a new projected revision fetches without waiting for the safety poll', async () => {
    await writeFile(join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'), 'v1')
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(stamped('press-1'))
    await puller.pullNow()
    puller.start()
    await writeFile(join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'), 'v2')

    await puller.accept(stamped('press-2'))
    // Spread across the herd window, not fired at the sync tick.
    const [pending] = timers.pending('revalidate')
    expect(pending?.delayMs).toBeLessThan(10 * 60 * 1_000)
    await timers.fire('revalidate')

    expect(
      await readFile(join(subscriberDriveDir, 'agents', 'research-assistant', 'AGENTS.md'), 'utf8'),
    ).toBe('v2')
  })

  test('a subscription with no projected revision revalidates exactly as before', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    await puller.accept(desired())

    // The old-backend path: absence means today's behaviour, everywhere.
    const [revalidate] = timers.pending('revalidate')
    expect(revalidate?.delayMs).toBeLessThan(CONVERGE_COMES_DUE_MS)
  })

  // THE GATE DELAYS, IT NEVER BLOCKS. A revision that stops moving while the
  // bytes keep changing — a hand-edit on the publisher's drive, the case the
  // deferred publisher-reported rung exists to close — must still converge, on
  // the safety poll, without anyone intervening.
  test('a stale projected revision still converges through the safety poll', async () => {
    await writeFile(join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'), 'v1')
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(stamped('press-1'))
    await puller.pullNow()
    puller.start()
    await puller.accept(stamped('press-1'))

    // The bytes move; nothing tells the control plane, so the token does not.
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'hand-edited',
    )
    currentTime += 24 * 60 * 60 * 1_000
    await timers.fire('revalidate')

    expect(
      await readFile(join(subscriberDriveDir, 'agents', 'research-assistant', 'AGENTS.md'), 'utf8'),
    ).toBe('hand-edited')
  })

  // On boot the sync's desired state arrives BEFORE the puller starts, so the
  // directed-pull trigger is skipped and the gate is the only thing scheduling.
  // A subscriber whose token disagrees would then sit on the long interval with
  // no pull ever triggered — stuck for half a day after every VM restart.
  test('a revision the subscriber has not pulled at does not gate, even with no trigger', async () => {
    await writeFile(join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'), 'v1')
    const fixture = createHubFixture()
    const first = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await first.accept(stamped('press-1'))
    await first.pullNow()

    const timers = createTimerFixture()
    const restarted = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await restarted.accept(stamped('press-2'))
    restarted.start()

    const [revalidate] = timers.pending('revalidate')
    expect(revalidate?.delayMs).toBeLessThan(CONVERGE_COMES_DUE_MS)
  })

  test('a first install is never gated', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    puller.start()

    // A revision arrives with the install itself: nothing has been pulled, so
    // there is no token to agree with and nothing to gate on.
    await puller.accept(stamped('press-1'))
    const deadline = Date.now() + 5_000
    while (puller.reports().length === 0 && Date.now() < deadline) await Bun.sleep(20)
    expect(puller.reports()).toMatchObject([{ subscriptionId: 'subscription-1', state: 'active' }])

    expect(fixture.requests.length).toBeGreaterThan(0)
    expect(
      await readFile(join(subscriberDriveDir, 'agents', 'research-assistant', 'AGENTS.md'), 'utf8'),
    ).toBe('official')
  })

  // A moved revision must not read as a moved SOURCE. Identity change drops the
  // manifest, and without the manifest every file already on disk looks like a
  // local addition, so nothing the publisher deletes is ever reaped again.
  test('a moved revision keeps the manifest that tracks the publisher’s deletions', async () => {
    const appDir = join(hubDriveDir, 'official-agents', 'research-assistant', 'apps', 'board')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'server.ts'), 'export {}\n')
    await writeFile(join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'), 'v1')
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(stamped('press-1'))
    await puller.pullNow()

    // The publisher deletes the app and the revision moves with it.
    await rm(join(hubDriveDir, 'official-agents', 'research-assistant', 'apps'), {
      recursive: true,
    })
    await puller.accept(stamped('press-2'))
    await puller.pullNow()

    expect(await readdir(join(subscriberDriveDir, 'agents', 'research-assistant'))).not.toContain(
      'apps',
    )
  })

  // The control plane owns the NUMBER and the VM owns the PREDICATE, so a bad
  // number must not be able to brick the fleet. The clamp is what makes the
  // worst case "today's traffic" at one end and "one day of staleness" at the
  // other, whatever the backend says.
  test('the projected interval is honored between its bounds and clamped outside them', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const gatedDelay = async (revalidateAfterMs?: number) => {
      await rm(subscriberStateDir, { recursive: true, force: true })
      await rm(join(subscriberDriveDir, 'agents'), { recursive: true, force: true })
      const timers = createTimerFixture()
      const puller = createMarketplaceAgentPuller({
        stateDir: subscriberStateDir,
        driveDir: subscriberDriveDir,
        fetch: fixture.fetch,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      })
      await puller.accept(stamped('press-1', revalidateAfterMs ?? null))
      await puller.pullNow()
      puller.start()
      return timers.pending('revalidate')[0]?.delayMs ?? 0
    }

    const hour = 60 * 60 * 1_000
    // Honored: two hours is inside the safe range, so it is used as given
    // (modulo the deterministic ±10% jitter every interval carries).
    expect(await gatedDelay(2 * hour)).toBeGreaterThan(1.5 * hour)
    expect(await gatedDelay(2 * hour)).toBeLessThan(2.5 * hour)
    // Clamped: a value that would poll harder than today, and one that would
    // effectively stop polling, both land inside the bounds.
    expect(await gatedDelay(1)).toBeGreaterThan(20 * 60 * 1_000)
    expect(await gatedDelay(30 * 24 * hour)).toBeLessThan(25 * hour)
    // Absent: the control plane owns the number, so a revision with no interval
    // gates nothing — the gateway never invents a fleet-wide policy of its own.
    expect(await gatedDelay()).toBeLessThan(hour)
  })

  // A dead publisher origin retries every six hours, not every thirty minutes.
  // A converge timer on a subscription that never installed would find no
  // snapshot, force an unconditional fetch to repair the boundary, and turn
  // that six-hour interval back into a half-hour one — a cost regression hidden
  // inside a change that is supposed to be cost-neutral.
  test('a subscription that never installed gets no converge timer', async () => {
    const timers = createTimerFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () => new Response('gone', { status: 404 }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    puller.start()

    await puller.accept(desired())
    const deadline = Date.now() + 5_000
    while (puller.reports().length === 0 && Date.now() < deadline) await Bun.sleep(20)

    expect(puller.reports()).toMatchObject([
      { subscriptionId: 'subscription-1', lastErrorCode: 'origin_unreachable' },
    ])
    expect(timers.pending('converge')).toEqual([])
    // ...and the network leg keeps its own long retry.
    expect(timers.pending('revalidate')[0]?.delayMs).toBeGreaterThan(60 * 60 * 1_000)
  })

  // Both timers hang off the same persisted clock and the same jitter, so they
  // come due together — and a successful poll has already converged. Without a
  // due check every subscriber would re-hash its whole agent folder and write a
  // second journal transaction every cycle, for a drive it just reconciled.
  test('a converge pass the poll already did is not repeated', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await rm(join(target, 'AGENTS.md'))

    // Due at the same instant as the poll that just converged, so it is not due.
    await timers.fire('converge')

    // The drive waits for the next pass that IS due, rather than paying for a
    // reconcile the poll performed moments ago.
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8').catch(() => '<gone>')).toBe('<gone>')
    currentTime += CONVERGE_COMES_DUE_MS
    await timers.fire('converge')
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('official')
  })

  // The snapshot IS the boundary, so losing it breaks convergence outright.
  // Leaving the ETag in place would let the origin keep answering 304 about
  // bytes this VM cannot read, and the drive would never be repairable again.
  test('a missing cached snapshot forces an unconditional refetch', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await rm(join(target, 'AGENTS.md'))
    await rm(join(subscriberStateDir, 'marketplace', 'subscription-1', 'snapshot.zip'))

    currentTime += CONVERGE_COMES_DUE_MS
    await timers.fire('converge')
    // The repair pull is fire-and-forget, so wait on what this test actually
    // claims — the restored file — not on the REQUEST that precedes it. Waiting
    // for the request count passes the moment the fetch is issued, while the
    // unzip and materialize are still running, and a loaded machine then fails
    // on a file that is about to exist.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const restored = await readFile(join(target, 'AGENTS.md'), 'utf8').catch(() => null)
      if (restored !== null) break
      await Bun.sleep(10)
    }

    expect(fixture.requests[1]?.ifNoneMatch).toBeNull()
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('official')
  })

  // `applyPullReportsImpl` is where a listing's app-declaration revision reaches
  // the subscription, so a report is a statement that the network said
  // something. Convergence learned nothing from the publisher and must stay
  // silent, or the local timer would drive a clock it cannot read.
  test('convergence produces no pull report', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    const reportsAfterPull = puller.reports()
    await rm(join(subscriberDriveDir, 'agents', 'research-assistant', 'AGENTS.md'))

    currentTime += CONVERGE_COMES_DUE_MS
    await timers.fire('converge')

    expect(reportsAfterPull).toMatchObject([{ subscriptionId: 'subscription-1', state: 'active' }])
    expect(puller.reports()).toEqual(reportsAfterPull)
  })

  // What makes a stuck fleet structurally impossible rather than carefully
  // avoided: the two jobs keep separate clocks, so no amount of local repair can
  // walk the network poll forward — the timer is never even touched.
  test('a local pass never postpones the network poll', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const timers = createTimerFixture()
    let currentTime = 10_000
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    puller.start()
    const pollWhenScheduled = timers.pending('revalidate')
    const requestsBefore = fixture.requests.length

    for (let pass = 0; pass < 3; pass += 1) {
      currentTime += CONVERGE_COMES_DUE_MS
      await timers.fire('converge')
    }

    // The SAME timer, not an equivalent one: a re-scheduled poll would carry a
    // new id even where the delay happened to match.
    expect(timers.pending('revalidate')).toEqual(pollWhenScheduled)
    expect(fixture.requests).toHaveLength(requestsBefore)
  })

  test('rejects a non-zip response before touching the live folder', async () => {
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'local.txt'), 'untouched')
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () =>
        new Response('hostile', {
          headers: { 'content-type': 'text/plain', etag: '"hostile"' },
        }),
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'invalid_content_type',
        observedAt: expect.any(Number),
      },
    ])
    expect(await readFile(join(target, 'local.txt'), 'utf8')).toBe('untouched')
    expect(await readdir(target)).toEqual(['local.txt'])
  })

  test('journals on the DRIVE filesystem, never the gateway state dir', async () => {
    // On a real VM the drive is a separate volume from the gateway's state dir,
    // and the materializer installs by hardlinking its staged copy over the
    // target — which is EXDEV across devices. Every other test in this file
    // points stateDir and driveDir at one tmpdir, so a cross-device journal
    // passes them all and fails on every real VM. This asserts the location
    // rather than the syscall, because a unit test cannot mount a second
    // filesystem.
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'active',
        appliedEtag: expect.any(String),
        lastAppliedAt: expect.any(Number),
      },
    ])

    // The journal lives beside the drive it writes into...
    const journalRoot = join(subscriberDriveDir, '.duet', 'marketplace', 'subscription-1')
    const journals = (await readdir(journalRoot)).filter(entry =>
      entry.includes('marketplace-materializer-'),
    )
    expect(journals).toHaveLength(1)
    // ...and the gateway state dir keeps ONLY the archive cache, which is never
    // linked into the drive and so may stay on the other filesystem.
    expect(await readdir(join(subscriberStateDir, 'marketplace', 'subscription-1'))).toEqual([
      'snapshot.zip',
    ])
  })

  test('a changed source still reaps the files it dropped', async () => {
    // A publisher renaming their publish changes the derived source URL, which
    // is an IDENTITY change for the puller. If that resets the manifest, every
    // file already on disk looks like a local addition and anything the
    // publisher deleted survives forever. This is the file-level half of that
    // — slice 04 blessed the reset reasoning only about conflict copies.
    const agentDir = join(hubDriveDir, 'official-agents', 'research-assistant')
    await writeFile(join(agentDir, 'AGENTS.md'), 'official')
    await mkdir(join(agentDir, '.agents', 'skills', 'retired'), { recursive: true })
    await writeFile(join(agentDir, '.agents', 'skills', 'retired', 'SKILL.md'), 'going away')
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
    })
    await puller.accept(desired())
    await puller.pullNow()
    const installed = join(subscriberDriveDir, 'agents', 'research-assistant')
    expect(await readFile(join(installed, '.agents/skills/retired/SKILL.md'), 'utf8')).toBe(
      'going away',
    )

    // The publisher drops the skill AND renames the publish, so the source URL
    // changes in the same beat.
    await rm(join(agentDir, '.agents', 'skills', 'retired'), { recursive: true, force: true })
    const renamed = desired()
    renamed.subscriptions[0]!.sourceUrl =
      'https://edge-staging.duet.so/hub-workspace/official-agents-v2/research-assistant?zip'
    await puller.accept(renamed)
    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'active',
        appliedEtag: expect.any(String),
        lastAppliedAt: expect.any(Number),
      },
    ])
    // The FILE is the contract; an emptied directory is cosmetic and the
    // materializer does not claim to prune those.
    expect(
      await readFile(join(installed, '.agents/skills/retired/SKILL.md'), 'utf8').catch(
        () => '<gone>',
      ),
    ).toBe('<gone>')
  })

  test('never follows a redirect off the edge host', async () => {
    // The edge-host allow-list is checked on the URL the puller is HANDED. A
    // followed 30x would fetch whatever host the response named, and that host
    // is never re-checked — so the firewall has to refuse redirects outright,
    // not merely validate the first URL.
    const requested: string[] = []
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'local.txt'), 'untouched')
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async (input, init) => {
        requested.push(String(input))
        expect(init?.redirect).toBe('manual')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/payload.zip' },
        })
      },
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'upstream_http_302',
        observedAt: expect.any(Number),
      },
    ])
    expect(requested).toEqual([
      'https://edge-staging.duet.so/hub-workspace/official-agents/research-assistant?zip',
    ])
    expect(await readdir(target)).toEqual(['local.txt'])
  })

  test('rejects a zip without an ETag before touching the live folder', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'local.txt'), 'untouched')
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init)
        const headers = new Headers(response.headers)
        headers.delete('etag')
        return new Response(response.body, { status: response.status, headers })
      },
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'missing_etag',
        observedAt: expect.any(Number),
      },
    ])
    expect(await readdir(target)).toEqual(['local.txt'])
  })

  // A download that stalls must become an ordinary retryable failure, not a
  // pull that never returns: pulls run one at a time, so a stalled body would
  // freeze every install queued behind it on this VM with nothing reported.
  test('a stalled archive download times out as a retryable failure', async () => {
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      archiveTimeoutMs: 300,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('PK'))
              // …and never another byte, never a close.
            },
          }),
          { headers: { 'content-type': 'application/zip', etag: '"zip-stalled"' } },
        ),
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    await puller.accept(desired())

    const outcome = await Promise.race([
      puller.pullNow(),
      Bun.sleep(3_000).then(() => 'never returned' as const),
    ])

    expect(outcome).not.toBe('never returned')
    if (typeof outcome === 'string') throw new Error(outcome)
    expect(outcome[0]).toMatchObject({ state: 'error', lastErrorCode: 'archive_timeout' })
  })

  test('rejects an oversized archive before touching the live folder', async () => {
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'local.txt'), 'untouched')
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () =>
        new Response(new Uint8Array(), {
          headers: {
            'content-type': 'application/zip',
            'content-length': String(512 * 1024 * 1024 + 1),
            etag: '"oversized"',
          },
        }),
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'recursive_limit_exceeded',
        observedAt: expect.any(Number),
      },
    ])
    expect(await readdir(target)).toEqual(['local.txt'])
  })

  test('stops reading an oversized streamed archive before touching the live folder', async () => {
    const target = join(subscriberDriveDir, 'agents', 'research-assistant')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'local.txt'), 'untouched')
    let canceled = false
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      maxArchiveBytes: 8,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(6))
              controller.enqueue(new Uint8Array(6))
            },
            cancel() {
              canceled = true
            },
          }),
          { headers: { 'content-type': 'application/zip', etag: '"streamed"' } },
        ),
    })
    await puller.accept(desired())

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'recursive_limit_exceeded',
        observedAt: expect.any(Number),
      },
    ])
    expect(canceled).toBe(true)
    expect(await readdir(target)).toEqual(['local.txt'])
  })

  test('schedules a stable half-hour-ish poll and resumes from the persisted apply time', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    let currentTime = 10_000
    const timers = createTimerFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    await puller.accept(desired())
    await puller.pullNow()
    currentTime += 1_000
    puller.start()

    // Both jobs are due half an hour after the pull that just did both of them,
    // each on its own timer and its own persisted clock.
    const revalidate = timers.pending('revalidate')
    const converge = timers.pending('converge')
    expect(revalidate).toHaveLength(1)
    expect(converge).toHaveLength(1)
    for (const timer of [...revalidate, ...converge]) {
      expect(timer.delayMs).toBeGreaterThanOrEqual(27 * 60 * 1_000 - 1_000)
      expect(timer.delayMs).toBeLessThanOrEqual(33 * 60 * 1_000 - 1_000)
    }
    const restartedTimers = createTimerFixture()
    const restarted = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      now: () => currentTime,
      setTimer: restartedTimers.setTimer,
      clearTimer: restartedTimers.clearTimer,
    })
    expect(restarted.reports()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'active',
        appliedEtag: expect.any(String),
        lastAppliedAt: 10_000,
      },
    ])
    await restarted.accept(desired())
    restarted.start()

    // A restart resumes BOTH clocks off the same state file, so a VM that
    // reboots every few minutes still cannot poll its publisher every few
    // minutes — nor drop the local repair.
    expect(restartedTimers.pending('revalidate').map(timer => timer.delayMs)).toEqual(
      revalidate.map(timer => timer.delayMs),
    )
    expect(restartedTimers.pending('converge').map(timer => timer.delayMs)).toEqual(
      converge.map(timer => timer.delayMs),
    )
  })

  // The sync loop is the only delivery that always reaches a VM — the API's
  // post-install push is best effort and misses a workspace that is still
  // booting. A subscription the sync hands over for the first time must not
  // wait for the half-hour poll: it is an install the user is watching.
  test('a started puller pulls a newly accepted subscription without being asked', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    puller.start()

    await puller.accept(desired())
    const deadline = Date.now() + 5_000
    while (puller.reports().length === 0 && Date.now() < deadline) await Bun.sleep(20)

    expect(fixture.requests).toHaveLength(1)
    expect(puller.reports()).toMatchObject([{ subscriptionId: 'subscription-1', state: 'active' }])

    // The same desired state again is not a new install.
    await puller.accept(desired())
    await Bun.sleep(100)
    expect(fixture.requests).toHaveLength(1)
  })

  // The gateway restarts on every fresh VM: the image's release hands over to
  // the announced one seconds after boot, mid-install. A subscription the
  // previous process accepted but never applied must not wait for the
  // half-hour poll after that restart.
  test('a restarted puller pulls a never-applied subscription on start', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const earlier = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    // Accepted, never started: the process died before any pull ran.
    await earlier.accept(desired())
    expect(fixture.requests).toHaveLength(0)

    const restarted = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    await restarted.accept(desired())
    restarted.start()
    const deadline = Date.now() + 5_000
    while (restarted.reports().length === 0 && Date.now() < deadline) await Bun.sleep(20)

    expect(fixture.requests).toHaveLength(1)
    expect(restarted.reports()).toMatchObject([
      { subscriptionId: 'subscription-1', state: 'active' },
    ])
  })

  test('sync repeats do not re-pull a never-applied install that is backing off', async () => {
    let attempts = 0
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () => {
        attempts += 1
        throw new Error('offline')
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    puller.start()
    await puller.accept(desired())
    const deadline = Date.now() + 5_000
    while (puller.reports().length === 0 && Date.now() < deadline) await Bun.sleep(20)
    expect(puller.reports()).toMatchObject([{ subscriptionId: 'subscription-1', state: 'error' }])
    expect(attempts).toBe(1)

    await puller.accept(desired())
    await puller.accept(desired())
    await Bun.sleep(100)
    expect(attempts).toBe(1)
  })

  test('does not postpone a pending poll when sync repeats unchanged desired state', async () => {
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      'official',
    )
    const fixture = createHubFixture()
    const delays: number[] = []
    const cleared: unknown[] = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: fixture.fetch,
      setTimer: (_callback, delayMs) => {
        delays.push(delayMs)
        return `timer-${delays.length}`
      },
      clearTimer: timer => void cleared.push(timer),
    })
    await puller.accept(desired())
    // Applied before start, so start has nothing stranded to pull and the only
    // timer is the regular poll.
    await puller.pullNow()
    puller.start()

    await puller.accept(desired())

    // One timer per job, both left exactly as `start` scheduled them.
    expect(delays).toHaveLength(2)
    expect(cleared).toEqual([])
  })

  test('backs retryable failures off exponentially with a five-minute bound', async () => {
    const delays: number[] = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () => {
        throw new Error('offline')
      },
      setTimer: (_callback, delayMs) => {
        delays.push(delayMs)
        return delays.length
      },
      clearTimer: () => undefined,
    })
    await puller.accept(desired())
    // Start pulls the never-applied subscription itself: that is attempt one.
    puller.start()

    for (let attempt = 0; attempt < 7; attempt += 1) await puller.pullNow()

    expect(delays.slice(-8)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ])
  })

  test('surfaces recursive_limit_exceeded without scheduling a retry loop', async () => {
    const delays: number[] = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () => Response.json({ error: 'recursive_limit_exceeded' }, { status: 409 }),
      setTimer: (_callback, delayMs) => {
        delays.push(delayMs)
        return delays.length
      },
      clearTimer: () => undefined,
    })
    await puller.accept(desired())
    puller.start()

    expect(await puller.pullNow()).toEqual([
      {
        subscriptionId: 'subscription-1',
        state: 'error',
        lastErrorCode: 'recursive_limit_exceeded',
        observedAt: expect.any(Number),
      },
    ])
    expect(delays.at(-1)).toBeGreaterThanOrEqual(27 * 60 * 1_000)
    expect(delays.at(-1)).toBeLessThanOrEqual(33 * 60 * 1_000)
  })

  test('a dead publisher origin backs off for hours, not five minutes', async () => {
    // 404/410/502/503/504 all mean "the origin is not there" — a deleted
    // publish, or an edge that cannot reach a sleeping or retired VM. Retrying
    // that every 5 minutes is 288 pointless probes a day per subscriber,
    // against a workspace that takes 7 days just to idle-retire.
    for (const status of [404, 410, 502, 503, 504]) {
      const delays: number[] = []
      const puller = createMarketplaceAgentPuller({
        stateDir: subscriberStateDir,
        driveDir: subscriberDriveDir,
        fetch: async () => new Response('gone', { status }),
        now: () => 10_000,
        setTimer: (_callback, delayMs) => {
          delays.push(delayMs)
          return 1
        },
        clearTimer: () => undefined,
      })
      await puller.accept(desired())
      puller.start()
      const reports = await puller.pullNow()

      expect(reports).toEqual([
        {
          subscriptionId: 'subscription-1',
          state: 'error',
          lastErrorCode: 'origin_unreachable',
          observedAt: expect.any(Number),
        },
      ])
      // Jittered around 6h, and unmistakably past the 5-minute generic ceiling.
      const scheduled = delays.at(-1)!
      expect(scheduled).toBeGreaterThan(60 * 60 * 1_000)
      expect(scheduled).toBeLessThanOrEqual(7 * 60 * 60 * 1_000)
      puller.stop()
    }
  })

  test('an ordinary failure keeps the short exponential backoff', async () => {
    // The long interval must be scoped to dead origins: a 500 from a live VM is
    // exactly the transient case the 5-minute ceiling exists for.
    const delays: number[] = []
    const puller = createMarketplaceAgentPuller({
      stateDir: subscriberStateDir,
      driveDir: subscriberDriveDir,
      fetch: async () => new Response('boom', { status: 500 }),
      now: () => 10_000,
      setTimer: (_callback, delayMs) => {
        delays.push(delayMs)
        return 1
      },
      clearTimer: () => undefined,
    })
    await puller.accept(desired())
    puller.start()
    const reports = await puller.pullNow()
    expect(reports[0]).toMatchObject({ state: 'error', lastErrorCode: 'upstream_http_500' })
    expect(delays.at(-1)!).toBeLessThanOrEqual(5 * 60 * 1_000)
    puller.stop()
  })
})

function desired(): VmDesiredMarketplaceAgents {
  return {
    subscriptions: [
      {
        subscriptionId: 'subscription-1',
        listingId: 'listing-1',
        sourceUrl:
          'https://edge-staging.duet.so/hub-workspace/official-agents/research-assistant?zip',
        agentName: 'research-assistant',
        path: 'agents/research-assistant',
        anchorId: 'anchor-1',
        mode: 'subscribe',
      },
    ],
  }
}

/**
 * The same desired state, carrying the control plane's opaque content token and
 * the interval that always rides with it — the backend projects both or
 * neither, so a fixture that sent only the token would pin a state production
 * cannot produce. Pass `null` to send the token alone deliberately.
 */
function stamped(
  contentRevision: string,
  revalidateAfterMs: number | null = 12 * 60 * 60 * 1_000,
): VmDesiredMarketplaceAgents {
  const base = desired()
  return {
    subscriptions: base.subscriptions.map(subscription => ({
      ...subscription,
      contentRevision,
      ...(revalidateAfterMs === null ? {} : { revalidateAfterMs }),
    })),
  }
}

/**
 * Records the puller's timers by kind so a test can fire ONE of them, and can
 * tell "still pending, untouched" from "cleared and rescheduled" — the timer id
 * only survives if nothing re-scheduled it.
 */
function createTimerFixture(): {
  setTimer: (callback: () => unknown, delayMs: number, kind: MarketplaceAgentTimerKind) => unknown
  clearTimer: (timer: unknown) => void
  pending(kind: MarketplaceAgentTimerKind): Array<{ id: number; delayMs: number }>
  fire(kind: MarketplaceAgentTimerKind): Promise<void>
} {
  let nextId = 0
  const scheduled = new Map<
    number,
    { kind: MarketplaceAgentTimerKind; delayMs: number; callback: () => unknown }
  >()
  return {
    setTimer(callback, delayMs, kind) {
      nextId += 1
      scheduled.set(nextId, { kind, delayMs, callback })
      return nextId
    },
    clearTimer(timer) {
      scheduled.delete(timer as number)
    },
    pending: kind =>
      [...scheduled.entries()]
        .filter(([, timer]) => timer.kind === kind)
        .map(([id, timer]) => ({ id, delayMs: timer.delayMs })),
    async fire(kind) {
      const entry = [...scheduled.entries()].find(([, timer]) => timer.kind === kind)
      if (entry === undefined) throw new Error(`no ${kind} timer is scheduled`)
      scheduled.delete(entry[0])
      await entry[1].callback()
    },
  }
}

function createHubFixture(): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  requests: Array<{ url: string; ifNoneMatch: string | null }>
} {
  const app = new Hono()
  app.route(
    '/public/publish',
    createPublishesRoutes({
      driveDir: hubDriveDir,
      stateDir: join(root, 'hub-state'),
    }),
  )
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = []
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push({ url: request.url, ifNoneMatch: request.headers.get('if-none-match') })
      const headers = new Headers(request.headers)
      headers.set(DUET_PUBLISH_KIND_HEADER, 'folder')
      headers.set(DUET_PUBLISH_ANCHOR_PATH_HEADER, 'official-agents')
      // Stand in for the edge: strip `/<workspace>/<publish>` and hand the rest
      // to the local publish mount, which is what the edge proxy does.
      const source = new URL(request.url)
      const nested = source.pathname.split('/').filter(Boolean).slice(2).join('/')
      const local = new URL(`http://gateway.local/public/publish/${nested}`)
      local.search = source.search
      return app.request(local.toString(), { method: request.method, headers })
    },
  }
}
