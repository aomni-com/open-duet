import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  ListingSourceUrlSchema,
  MAX_RECURSIVE_FILE_BYTES,
  MarketplaceAgentPullReportSchema,
  VmDesiredMarketplaceAgentsSchema,
  type MarketplaceAgentPullReport,
  type VmDesiredMarketplaceAgents,
} from '@repo/contract'

import {
  convergeFromSnapshot,
  type ConvergeFromSnapshotError,
  type ConvergeFromSnapshotResult,
} from './convergence'
import type { UpstreamManifest } from './materializer'
import {
  createMarketplaceAgentSubscriptionStore,
  type StoredMarketplaceAgentSubscription,
} from './subscription-store'

// The pull bounds are the serving bounds: the hub publish's zip walk and the
// puller must agree on one limit owner or the rails drift apart.
const MAX_ARCHIVE_BYTES = MAX_RECURSIVE_FILE_BYTES
// The whole download — headers and body. Pulls run one at a time, so a body
// that stalls would otherwise hold every install queued behind it on this VM,
// reporting nothing; past this it is a retryable failure like any other.
const DEFAULT_ARCHIVE_TIMEOUT_MS = 2 * 60 * 1_000
const SNAPSHOT_FILE = 'snapshot.zip'
const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1_000
/**
 * The gate may only ever stretch the interval, never shorten it and never
 * remove it. The floor keeps a wrong projected value costing at most today's
 * traffic; the ceiling keeps one costing at most a day of staleness. Both are
 * enforced HERE rather than trusted from the wire, so no backend value alone
 * can produce a fleet that never revalidates again.
 */
const MIN_GATED_REVALIDATE_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS
const MAX_GATED_REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000
/**
 * A revision change is a herd: every subscriber of a listing is told at the same
 * 5s tick. The ones whose bytes actually moved cannot short-circuit to a 304, so
 * each of those is a full archive build on one publisher's VM. Spread them
 * uniformly across this window.
 */
const REVISION_PULL_SPREAD_MS = 10 * 60 * 1_000
/**
 * Convergence repairs the drive from the snapshot already on disk, so its
 * cadence is a local-repair floor rather than a request budget. It is separate
 * from the poll interval on purpose: the two are free to move apart, and only
 * one of them can cost the fleet anything.
 */
const DEFAULT_CONVERGE_INTERVAL_MS = 30 * 60 * 1_000
const ERROR_BACKOFF_BASE_MS = 5_000
const ERROR_BACKOFF_MAX_MS = 5 * 60 * 1_000
/**
 * A publisher whose VM is asleep, retired, unpaid or deleted is not a transient
 * error, and 5 minutes is the wrong cadence for it: every subscriber would
 * re-probe a dead origin 288 times a day, each attempt costing an edge lookup.
 * Servicing decommission takes 7 days, so hours is the honest interval.
 */
const ORIGIN_UNREACHABLE_BACKOFF_MS = 6 * 60 * 60 * 1_000

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Which of the poll's two jobs a timer owns. Only `revalidate` opens a socket;
 * `converge` is local repair and must never be able to postpone the other.
 */
export type MarketplaceAgentTimerKind = 'revalidate' | 'converge'

const TIMER_KINDS: readonly MarketplaceAgentTimerKind[] = ['revalidate', 'converge']

type MarketplaceAgentPullStage =
  | 'inspect_cache'
  | 'fetch_archive'
  | 'read_archive'
  | 'decode_archive'
  | 'materialize_files'
  | 'persist_snapshot'
  | 'persist_subscription'

/**
 * Which phase of a pull a convergence error belongs to, so the diagnostic log
 * names the step that actually failed rather than the call that wrapped it.
 */
const CONVERGE_ERROR_STAGES: Record<ConvergeFromSnapshotError, MarketplaceAgentPullStage> = {
  cached_snapshot_missing: 'read_archive',
  invalid_archive: 'decode_archive',
  recursive_limit_exceeded: 'decode_archive',
}

export interface MarketplaceAgentPullerOptions {
  stateDir: string
  /** Ceiling on one archive download, headers through last byte. */
  archiveTimeoutMs?: number
  driveDir: string
  fetch: FetchLike
  now?: () => number
  pollIntervalMs?: number
  /** How often the drive is reconciled onto the cached snapshot. Costs no request. */
  convergeIntervalMs?: number
  /** Archive-boundary probe seam; production uses the publish rail's 512 MiB limit. */
  maxArchiveBytes?: number
  setTimer?: (callback: () => unknown, delayMs: number, kind: MarketplaceAgentTimerKind) => unknown
  clearTimer?: (timer: unknown) => void
  postApply?: (applied: {
    subscriptionId: string
    path: string
    anchorId: string
    etag: string
  }) => void | Promise<void>
  log?: (fields: Record<string, unknown>) => void
}

export interface MarketplaceAgentPuller {
  accept(desired: VmDesiredMarketplaceAgents | undefined): Promise<void>
  pullNow(): Promise<MarketplaceAgentPullReport[]>
  start(): void
  stop(): void
  reports(): MarketplaceAgentPullReport[]
  acknowledge(reports: MarketplaceAgentPullReport[]): void
}

export function createMarketplaceAgentPuller(
  options: MarketplaceAgentPullerOptions,
): MarketplaceAgentPuller {
  const now = options.now ?? Date.now
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const convergeIntervalMs = options.convergeIntervalMs ?? DEFAULT_CONVERGE_INTERVAL_MS
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES
  const archiveTimeoutMs = options.archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const store = createMarketplaceAgentSubscriptionStore(options.stateDir)
  const reportOutbox = new Map<string, MarketplaceAgentPullReport>()
  for (const subscription of store.current()) {
    const report = reportFromStored(subscription)
    if (report !== null) reportOutbox.set(subscription.subscriptionId, report)
  }
  const modes = new Map<string, 'subscribe' | 'clone_once'>()
  // Desired state that is NOT identity: a changed revision must not read as a
  // changed source, which would drop the manifest and re-download everything.
  const desiredRevisions = new Map<string, string>()
  const desiredRevalidateAfterMs = new Map<string, number>()
  /**
   * The last revision each subscription was actually sent to fetch on. The
   * projection is a LEVEL — it arrives every five seconds — so without this a
   * revision no origin will ever serve would be re-triggered forever, fleet
   * wide. In memory, not on disk: re-checking once after a restart is a feature.
   */
  const lastTriggeredRevision = new Map<string, string>()
  const timers: Record<MarketplaceAgentTimerKind, Map<string, unknown>> = {
    revalidate: new Map(),
    converge: new Map(),
  }
  const failureCounts = new Map<string, number>()
  let tail = Promise.resolve<unknown>(undefined)
  // App reconciles run behind the pulls, not inside them: `active` means the
  // agent's files landed, and bringing its apps up is the supervisor's job with
  // its own status. They still run one at a time so two installs cannot
  // interleave their content-generation bumps.
  let postApplyTail = Promise.resolve()
  const inFlight = new Set<string>()
  let started = false

  return {
    accept(desired) {
      const operation = tail.then(() => acceptDesired(desired))
      tail = operation.catch(error => {
        options.log?.({
          operation: 'marketplace_desired_accept',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return operation
    },

    pullNow() {
      return enqueuePull()
    },

    start() {
      if (started) return
      started = true
      for (const subscription of store.current()) {
        for (const kind of TIMER_KINDS) scheduleRegular(kind, subscription)
      }
      // A process restart — every fresh VM has one, seconds after boot, when
      // the image's release hands over to the announced one — kills the pull
      // chain mid-install. Whatever the previous process accepted but never
      // applied is pulled now, not on the half-hour poll.
      const stranded = neverApplied(store.current(), { retryFailed: true })
      if (stranded.length > 0) void enqueuePull(stranded)
    },

    stop() {
      started = false
      for (const kind of TIMER_KINDS) {
        for (const subscriptionId of timers[kind].keys()) clearScheduled(kind, subscriptionId)
      }
    },

    reports: () =>
      [...reportOutbox.values()]
        .map(report => structuredClone(report))
        .sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)),

    acknowledge(reports) {
      for (const report of reports) {
        const current = reportOutbox.get(report.subscriptionId)
        if (current !== undefined && JSON.stringify(current) === JSON.stringify(report)) {
          reportOutbox.delete(report.subscriptionId)
        }
      }
    },
  }

  function acceptDesired(desired: VmDesiredMarketplaceAgents | undefined): void {
    const parsed =
      desired === undefined ? undefined : VmDesiredMarketplaceAgentsSchema.parse(desired)
    const previous = new Map(store.current().map(item => [item.subscriptionId, item]))
    const previousModes = new Map(modes)
    const unchangedIdentities = new Set<string>()
    const unchangedSchedules = new Set<string>()
    const next =
      parsed?.subscriptions.map(subscription => {
        const identity = {
          subscriptionId: subscription.subscriptionId,
          agentName: subscription.agentName,
          listingId: subscription.listingId,
          sourceUrl: subscription.sourceUrl,
          path: subscription.path,
          anchorId: subscription.anchorId,
        }
        const old = previous.get(subscription.subscriptionId)
        if (old !== undefined && sameIdentity(old, identity)) {
          unchangedIdentities.add(subscription.subscriptionId)
          if (previousModes.get(subscription.subscriptionId) === subscription.mode) {
            unchangedSchedules.add(subscription.subscriptionId)
          }
          return { ...old, ...identity }
        }
        // A changed SOURCE must still be able to reap what the old one owned.
        // The manifest is the record of which files the publisher used to own;
        // dropping it makes every file already on disk look like a local
        // addition, so anything deleted upstream survives forever. Carry it
        // whenever the target directory is unchanged — the ETag deliberately is
        // NOT carried, so the new source is always fetched in full.
        // A changed PATH is a different directory, which legitimately starts
        // empty.
        return {
          ...identity,
          manifest: old !== undefined && old.path === identity.path ? old.manifest : { files: {} },
        }
      }) ?? []
    store.replace(next)
    modes.clear()
    const previousRevisions = new Map(desiredRevisions)
    desiredRevisions.clear()
    desiredRevalidateAfterMs.clear()
    for (const subscription of parsed?.subscriptions ?? []) {
      modes.set(subscription.subscriptionId, subscription.mode)
      if (subscription.contentRevision !== undefined) {
        desiredRevisions.set(subscription.subscriptionId, subscription.contentRevision)
      }
      if (subscription.revalidateAfterMs !== undefined) {
        desiredRevalidateAfterMs.set(subscription.subscriptionId, subscription.revalidateAfterMs)
      }
    }
    for (const subscriptionId of reportOutbox.keys()) {
      if (!unchangedIdentities.has(subscriptionId)) {
        reportOutbox.delete(subscriptionId)
      }
    }
    for (const subscriptionId of failureCounts.keys()) {
      if (!unchangedSchedules.has(subscriptionId)) failureCounts.delete(subscriptionId)
    }
    if (started) {
      for (const kind of TIMER_KINDS) {
        for (const subscriptionId of timers[kind].keys()) {
          if (!unchangedSchedules.has(subscriptionId)) clearScheduled(kind, subscriptionId)
        }
      }
      for (const subscription of next) {
        // A moved revision changes what the revalidate timer should be, so its
        // pending timer is stale even though the identity is unchanged. The
        // converge timer is untouched: local repair does not care what the
        // publisher's bytes are at.
        if (
          previousRevisions.get(subscription.subscriptionId) !==
          desiredRevisions.get(subscription.subscriptionId)
        ) {
          clearScheduled('revalidate', subscription.subscriptionId)
        }
        for (const kind of TIMER_KINDS) {
          if (!timers[kind].has(subscription.subscriptionId)) scheduleRegular(kind, subscription)
        }
      }
      // A revision the subscriber has not pulled at is a directed fetch, spread
      // across the herd window rather than fired at once.
      for (const subscription of next) {
        const revision = desiredRevisions.get(subscription.subscriptionId)
        if (
          revision === undefined ||
          modes.get(subscription.subscriptionId) !== 'subscribe' ||
          revision === subscription.pulledRevision ||
          revision === lastTriggeredRevision.get(subscription.subscriptionId)
        ) {
          continue
        }
        lastTriggeredRevision.set(subscription.subscriptionId, revision)
        schedule(
          'revalidate',
          subscription.subscriptionId,
          spreadOffset(subscription.subscriptionId, REVISION_PULL_SPREAD_MS),
        )
      }
      // A subscription the sync hands over that has never applied — new, or
      // with a new source — is an install someone is watching. The API pushes
      // a pull too, but that push is best effort and misses a workspace still
      // booting; the sync is the delivery that always arrives, so it pulls,
      // now, rather than leaving the install to the half-hour poll. One that
      // is already failing stays with its backoff timer.
      const arrived = neverApplied(next, { retryFailed: false })
      if (arrived.length > 0) void enqueuePull(arrived)
    }
  }

  function neverApplied(
    subscriptions: readonly StoredMarketplaceAgentSubscription[],
    options: { retryFailed: boolean },
  ): string[] {
    return subscriptions
      .filter(
        subscription =>
          subscription.lastRevalidatedAt === undefined &&
          !inFlight.has(subscription.subscriptionId) &&
          (options.retryFailed || subscription.lastErrorCode === undefined),
      )
      .map(subscription => subscription.subscriptionId)
  }

  function enqueuePull(subscriptionIds?: string[]): Promise<MarketplaceAgentPullReport[]> {
    const operation = tail.then(async () => {
      const reports: MarketplaceAgentPullReport[] = []
      const subscriptions = store.current()
      const requested = subscriptionIds === undefined ? null : new Set(subscriptionIds)
      for (const subscription of subscriptions.filter(
        item => requested === null || requested.has(item.subscriptionId),
      )) {
        clearScheduled('revalidate', subscription.subscriptionId)
        inFlight.add(subscription.subscriptionId)
        const report = await pullOne(subscription).finally(() =>
          inFlight.delete(subscription.subscriptionId),
        )
        reports.push(report)
        reportOutbox.set(subscription.subscriptionId, report)
        if (report.state === 'active') {
          failureCounts.delete(subscription.subscriptionId)
          const applied = currentSubscription(subscription.subscriptionId) ?? subscription
          // A successful pull converged too, so both clocks moved.
          for (const kind of TIMER_KINDS) scheduleRegular(kind, applied)
        } else {
          scheduleAfterFailure(
            currentSubscription(subscription.subscriptionId) ?? subscription,
            report.lastErrorCode,
          )
        }
      }
      return reports
    })
    tail = operation.catch(() => undefined)
    return operation
  }

  /**
   * Each job keeps its own clock. A timer is due one interval after the last
   * time ITS job ran, so a burst of local repair cannot walk the network poll
   * forward and a stretched poll cannot starve the repair.
   */
  function scheduleRegular(
    kind: MarketplaceAgentTimerKind,
    subscription: StoredMarketplaceAgentSubscription,
  ): void {
    if (!started || modes.get(subscription.subscriptionId) !== 'subscribe') return
    const interval = stablePollInterval(
      subscription.subscriptionId,
      kind === 'revalidate' ? revalidateIntervalFor(subscription) : convergeIntervalMs,
    )
    const lastRun =
      kind === 'revalidate' ? subscription.lastRevalidatedAt : subscription.lastConvergedAt
    // There is nothing to converge onto until a snapshot exists. Before the
    // first successful pull the network leg owns getting one, on its own
    // backoff — a converge timer here would find no snapshot, force an
    // unconditional fetch, and quietly undo a dead origin's long retry interval.
    if (kind === 'converge' && lastRun === undefined) return
    const delay = lastRun === undefined ? interval : Math.max(0, lastRun + interval - now())
    schedule(kind, subscription.subscriptionId, delay)
  }

  /**
   * THE GATE. It chooses between two intervals and never between polling and
   * not: a gate that could reach zero would make one wrong stored revision
   * permanently blinding, while one that only stretches heals itself on the
   * next safety poll.
   *
   * The predicate lives here rather than in the control plane because only this
   * VM knows whether its cached snapshot survived — the boundary the whole
   * convergence pass reads from. `pulledRevision` is cleared with the ETag when
   * that boundary breaks, so a broken snapshot cannot be gated.
   */
  function revalidateIntervalFor(subscription: StoredMarketplaceAgentSubscription): number {
    const revision = desiredRevisions.get(subscription.subscriptionId)
    if (revision === undefined || revision !== subscription.pulledRevision) return pollIntervalMs
    // The control plane owns the number and projects it with the revision or not
    // at all. No local default: a gateway inventing one would be a second owner
    // for a fleet-wide policy, and inventing a LONG one would quietly break the
    // rule that absence means today's behaviour.
    const projected = desiredRevalidateAfterMs.get(subscription.subscriptionId)
    if (projected === undefined) return pollIntervalMs
    return Math.min(
      MAX_GATED_REVALIDATE_INTERVAL_MS,
      Math.max(MIN_GATED_REVALIDATE_INTERVAL_MS, projected),
    )
  }

  /**
   * Only the network leg backs off. Convergence keeps its own timer: an origin
   * that is down or dead is exactly when local repair must keep running.
   */
  function scheduleAfterFailure(
    subscription: StoredMarketplaceAgentSubscription,
    errorCode: string,
  ): void {
    if (!started || modes.get(subscription.subscriptionId) !== 'subscribe') return
    if (errorCode === 'origin_unreachable') {
      // Not a failure count: a dead origin does not get "worse", so backing off
      // exponentially from it is meaningless. One long, jittered interval, reset
      // the moment a pull succeeds.
      failureCounts.delete(subscription.subscriptionId)
      schedule(
        'revalidate',
        subscription.subscriptionId,
        stablePollInterval(subscription.subscriptionId, ORIGIN_UNREACHABLE_BACKOFF_MS),
      )
      return
    }
    if (errorCode === 'recursive_limit_exceeded') {
      failureCounts.delete(subscription.subscriptionId)
      schedule(
        'revalidate',
        subscription.subscriptionId,
        stablePollInterval(subscription.subscriptionId, pollIntervalMs),
      )
      return
    }
    const failures = (failureCounts.get(subscription.subscriptionId) ?? 0) + 1
    failureCounts.set(subscription.subscriptionId, failures)
    schedule(
      'revalidate',
      subscription.subscriptionId,
      Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** (failures - 1)),
    )
  }

  function schedule(
    kind: MarketplaceAgentTimerKind,
    subscriptionId: string,
    delayMs: number,
  ): void {
    clearScheduled(kind, subscriptionId)
    const timer = setTimer(
      () => {
        timers[kind].delete(subscriptionId)
        return kind === 'revalidate'
          ? enqueuePull([subscriptionId])
          : enqueueConverge(subscriptionId)
      },
      delayMs,
      kind,
    )
    timers[kind].set(subscriptionId, timer)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref(): void }).unref()
    }
  }

  function clearScheduled(kind: MarketplaceAgentTimerKind, subscriptionId: string): void {
    const timer = timers[kind].get(subscriptionId)
    if (timer === undefined) return
    clearTimer(timer)
    timers[kind].delete(subscriptionId)
  }

  function currentSubscription(
    subscriptionId: string,
  ): StoredMarketplaceAgentSubscription | undefined {
    return store.current().find(item => item.subscriptionId === subscriptionId)
  }

  async function pullOne(
    subscription: StoredMarketplaceAgentSubscription,
  ): Promise<MarketplaceAgentPullReport> {
    let stage: MarketplaceAgentPullStage = 'inspect_cache'
    try {
      const archivePath = snapshotPath(options.stateDir, subscription.subscriptionId)
      const hasSnapshot = await isRegularFile(archivePath)
      const headers = new Headers()
      if (hasSnapshot && subscription.etag !== undefined) {
        headers.set('if-none-match', subscription.etag)
      }
      // Read BEFORE the request, so a projection that moves mid-flight does not
      // get credited to bytes this pull never saw.
      const revisionAtRequest = desiredRevisions.get(subscription.subscriptionId)
      stage = 'fetch_archive'
      const deadline = AbortSignal.timeout(archiveTimeoutMs)
      // `redirect: 'manual'` is part of the edge-host firewall, not a detail:
      // following a redirect would fetch whatever host the 30x named, and that
      // host is never re-checked against EDGE_HOSTS. A redirect is a failed
      // pull; `responseFailure` classifies the 3xx like any other bad status.
      const response = await options.fetch(upstreamUrl(subscription), {
        headers,
        redirect: 'manual',
        signal: deadline,
      })
      let archive: Uint8Array | null = null
      let etag: string
      stage = 'read_archive'
      if (response.status === 304) {
        if (!hasSnapshot || subscription.etag === undefined) {
          throw new PullFailure('cached_snapshot_missing')
        }
        etag = subscription.etag
      } else if (response.status === 200) {
        validateArchiveResponse(response, maxArchiveBytes)
        archive = await readBoundedResponseBody(response, maxArchiveBytes, deadline)
        etag = response.headers.get('etag')!
      } else {
        throw await responseFailure(response)
      }

      const current = currentSubscription(subscription.subscriptionId)
      if (current === undefined || !sameIdentity(current, subscription)) {
        throw new PullFailure('pull_superseded')
      }
      // The network leg's whole job ends here: `snapshot.zip` now holds the
      // publisher's current bytes. Everything after this is the local job, and
      // reads only what this line wrote.
      if (archive !== null) {
        stage = 'persist_snapshot'
        await writeAtomicBytes(archivePath, archive)
      }
      const appliedAt = now()
      stage = 'materialize_files'
      const converged = await applyCachedSnapshot(subscription, {
        at: appliedAt,
        // A download that replaced a snapshot this VM did not have cannot vouch
        // for the stored manifest, so nothing on disk is treated as the
        // publisher's.
        previous: hasSnapshot ? subscription.manifest : null,
      })
      if ('error' in converged) {
        stage = CONVERGE_ERROR_STAGES[converged.error]
        throw new PullFailure(converged.error, converged.error !== 'recursive_limit_exceeded')
      }
      stage = 'persist_subscription'
      replaceStoredSubscription(subscription.subscriptionId, {
        ...subscription,
        etag,
        // Banked only on a SUCCESSFUL network pull, and taken from the value in
        // force at the time of the request: a pull that failed leaves the
        // subscription ungated, and one that raced a new projection does not
        // claim to have fetched the newer revision.
        // Read before the request so a projection moving R1 -> R2 mid-flight is
        // not credited to bytes this pull never saw; re-checked after, because
        // R1 -> ABSENT is the opposite race. Absent means the publish was paused
        // and the origin has already switched to frozen bytes, so banking R1
        // would gate this subscriber onto a tree it has never seen once the
        // publish is unpaused and R1 projects again.
        ...(revisionAtRequest === undefined ||
        desiredRevisions.get(subscription.subscriptionId) !== revisionAtRequest
          ? {}
          : { pulledRevision: revisionAtRequest }),
        manifest: converged.manifest,
        lastRevalidatedAt: appliedAt,
        lastConvergedAt: appliedAt,
        lastErrorCode: undefined,
      })
      runPostApply({
        subscriptionId: subscription.subscriptionId,
        path: subscription.path,
        anchorId: subscription.anchorId,
        etag,
      })
      return MarketplaceAgentPullReportSchema.parse({
        subscriptionId: subscription.subscriptionId,
        state: 'active',
        appliedEtag: etag,
        lastAppliedAt: appliedAt,
      })
    } catch (error) {
      const failure = asPullFailure(error)
      const observedAt = now()
      const current = currentSubscription(subscription.subscriptionId)
      if (current !== undefined && sameIdentity(current, subscription)) {
        replaceStoredSubscription(subscription.subscriptionId, {
          ...current,
          lastErrorCode: failure.code,
          lastErrorAt: observedAt,
        })
      }
      options.log?.({
        operation: 'marketplace_pull',
        subscriptionId: subscription.subscriptionId,
        status: 'failed',
        error: failure.code,
        retryable: failure.retryable,
        stage,
        exception: error,
      })
      return MarketplaceAgentPullReportSchema.parse({
        subscriptionId: subscription.subscriptionId,
        state: 'error',
        lastErrorCode: failure.code,
        observedAt,
      })
    }
  }

  function enqueueConverge(subscriptionId: string): Promise<void> {
    const operation = tail.then(() => convergeOne(subscriptionId))
    tail = operation.catch(() => undefined)
    return operation
  }

  /**
   * The local job, on its own timer. It reconciles the drive with the snapshot
   * already on disk and opens no socket, so it keeps repairing a user's deleted
   * file while the publisher's origin is unreachable, paused, or merely quiet.
   *
   * It writes no report: `reportOutbox` is the network leg's, because a report
   * is what carries `appDeclarationRevision` back to the subscription, and that
   * clock must not be advanced by a pass that learned nothing from the origin.
   */
  async function convergeOne(subscriptionId: string): Promise<void> {
    const subscription = currentSubscription(subscriptionId)
    if (subscription === undefined) return
    const convergedAt = now()
    const interval = stablePollInterval(subscriptionId, convergeIntervalMs)
    // A successful poll converges too, and both timers run off the same jitter,
    // so they come due together. Redoing the pass the poll just did would
    // re-hash the whole agent folder and write a second journal transaction for
    // a drive already known to match.
    if (
      subscription.lastConvergedAt !== undefined &&
      convergedAt - subscription.lastConvergedAt < interval
    ) {
      scheduleRegular('converge', subscription)
      return
    }
    try {
      const result = await applyCachedSnapshot(subscription, {
        at: convergedAt,
        previous: subscription.manifest,
      })
      if ('error' in result) {
        options.log?.({
          operation: 'marketplace_converge',
          subscriptionId,
          status: 'failed',
          error: result.error,
        })
        if (result.error !== 'recursive_limit_exceeded') {
          // The boundary itself is broken: the snapshot is gone or unreadable.
          // Dropping the ETag makes the next fetch unconditional, because an
          // origin answering 304 about bytes this VM cannot read would leave the
          // drive unrepairable forever.
          // `pulledRevision` goes with the ETag: both mean "I hold known-good
          // bytes", and a gate left standing over an unreadable snapshot would
          // stretch the one fetch that could repair it.
          replaceStoredSubscription(subscriptionId, {
            ...subscription,
            etag: undefined,
            pulledRevision: undefined,
          })
          void enqueuePull([subscriptionId])
        }
      } else {
        replaceStoredSubscription(subscriptionId, {
          ...subscription,
          manifest: result.manifest,
          lastConvergedAt: convergedAt,
        })
      }
    } catch (error) {
      options.log?.({
        operation: 'marketplace_converge',
        subscriptionId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        exception: error,
      })
    }
    // One interval after this ATTEMPT, never from the persisted clock: a failed
    // pass leaves that clock stale, and rescheduling off it would spin.
    if (started && modes.get(subscriptionId) === 'subscribe') {
      schedule('converge', subscriptionId, interval)
    }
  }

  function applyCachedSnapshot(
    subscription: StoredMarketplaceAgentSubscription,
    input: { at: number; previous: UpstreamManifest | null },
  ): Promise<ConvergeFromSnapshotResult> {
    return convergeFromSnapshot({
      snapshotPath: snapshotPath(options.stateDir, subscription.subscriptionId),
      subscription,
      previous: input.previous,
      driveDir: options.driveDir,
      // The journal MUST live on the drive's own filesystem. It installs
      // files by hardlinking a staged copy over the target and quarantines a
      // live file by renaming it in — both fail with EXDEV across devices, and
      // on a real VM the drive is a separate volume from the gateway's state
      // dir. Every unit test used one tmpdir for both, so this held locally
      // and had never once materialized a file on a real VM.
      // `<drive>/.duet` is the established drive-local staging home (uploads
      // use it too) and is excluded from sync by WHOLE_DRIVE_IGNORE.
      stateDir: join(
        options.driveDir,
        '.duet',
        'marketplace',
        safeSubscriptionId(subscription.subscriptionId),
      ),
      maxArchiveBytes,
      now: input.at,
    })
  }

  function runPostApply(applied: Parameters<NonNullable<typeof options.postApply>>[0]): void {
    const postApply = options.postApply
    if (postApply === undefined) return
    postApplyTail = postApplyTail
      .then(() => postApply(applied))
      .catch(error => {
        // An app that will not come up is the app's error, shown on its own
        // card by the supervisor's reconciliation report; the install stands.
        options.log?.({
          operation: 'marketplace_post_apply',
          subscriptionId: applied.subscriptionId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          exception: error,
        })
      })
  }

  function replaceStoredSubscription(
    subscriptionId: string,
    replacement: StoredMarketplaceAgentSubscription,
  ): void {
    store.replace(
      store
        .current()
        .map(current => (current.subscriptionId === subscriptionId ? replacement : current)),
    )
  }
}

/**
 * A UNIFORM offset over `[0, windowMs)`, deterministic per subscription.
 *
 * Deliberately not `stablePollInterval`: that jitters ±10% around an interval,
 * which de-synchronizes a repeating timer but would concentrate a one-shot herd
 * into a band a fifth as wide — every subscriber of a listing inside one
 * minute, on one publisher's VM, each building a full archive.
 */
function spreadOffset(subscriptionId: string, windowMs: number): number {
  const sample = createHash('sha256').update(subscriptionId).digest().readUInt32BE(4) / 0x100000000
  return Math.floor(windowMs * sample)
}

function stablePollInterval(subscriptionId: string, intervalMs: number): number {
  const sample = createHash('sha256').update(subscriptionId).digest().readUInt32BE(0) / 0xffffffff
  return Math.round(intervalMs * (0.9 + sample * 0.2))
}

function reportFromStored(
  subscription: StoredMarketplaceAgentSubscription,
): MarketplaceAgentPullReport | null {
  if (subscription.lastErrorCode !== undefined) {
    return MarketplaceAgentPullReportSchema.parse({
      subscriptionId: subscription.subscriptionId,
      state: 'error',
      lastErrorCode: subscription.lastErrorCode,
      // Replayed from the store, so it carries WHEN it was observed rather than
      // looking freshly-observed on every redelivery.
      ...(subscription.lastErrorAt === undefined ? {} : { observedAt: subscription.lastErrorAt }),
    })
  }
  if (subscription.etag !== undefined && subscription.lastRevalidatedAt !== undefined) {
    return MarketplaceAgentPullReportSchema.parse({
      subscriptionId: subscription.subscriptionId,
      state: 'active',
      appliedEtag: subscription.etag,
      // The wire is unchanged: a report's `lastAppliedAt` is the last time the
      // network revalidated, which is the only half a publisher can move.
      lastAppliedAt: subscription.lastRevalidatedAt,
    })
  }
  return null
}

class PullFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true,
  ) {
    super(code)
  }
}

function asPullFailure(error: unknown): PullFailure {
  if (error instanceof PullFailure) return error
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new PullFailure('archive_timeout')
  }
  return new PullFailure('pull_failed')
}

function sameIdentity(
  left: StoredMarketplaceAgentSubscription,
  right: Pick<
    StoredMarketplaceAgentSubscription,
    'subscriptionId' | 'agentName' | 'listingId' | 'sourceUrl' | 'path' | 'anchorId'
  >,
): boolean {
  return (
    left.subscriptionId === right.subscriptionId &&
    left.agentName === right.agentName &&
    left.sourceUrl === right.sourceUrl &&
    left.listingId === right.listingId &&
    left.path === right.path &&
    left.anchorId === right.anchorId
  )
}

function upstreamUrl(subscription: StoredMarketplaceAgentSubscription): string {
  // The URL arrives fully formed from the backend projection; this process no
  // longer builds one. Re-parsing it is the independent check that a VM never
  // fetches a host outside EDGE_HOSTS, whatever it was handed.
  return ListingSourceUrlSchema.parse(subscription.sourceUrl)
}

function validateArchiveResponse(response: Response, maxArchiveBytes: number): void {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/zip') throw new PullFailure('invalid_content_type')
  const etag = response.headers.get('etag')
  if (etag === null || etag.trim().length === 0) throw new PullFailure('missing_etag')
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (/^\d+$/.test(contentLength) === false || Number(contentLength) > maxArchiveBytes)
  ) {
    throw new PullFailure('recursive_limit_exceeded', false)
  }
}

/**
 * Statuses that mean "this publisher's origin is not there", as opposed to
 * "this request failed". 404/410 is a deleted or unresolvable publish; 502/503
 * is the edge failing to reach a VM that is asleep or retired. A paused
 * workspace serves its paused page as a NON-archive 200, which
 * `validateArchiveResponse` already rejects on content-type — that path stays
 * a generic failure rather than being guessed at here.
 */
const ORIGIN_UNREACHABLE_STATUSES = new Set([404, 410, 502, 503, 504])

async function responseFailure(response: Response): Promise<PullFailure> {
  if (ORIGIN_UNREACHABLE_STATUSES.has(response.status)) {
    return new PullFailure('origin_unreachable')
  }
  if (response.status === 409) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null
    if (body?.error === 'recursive_limit_exceeded') {
      return new PullFailure('recursive_limit_exceeded', false)
    }
  }
  return new PullFailure(`upstream_http_${response.status}`)
}

async function readBoundedResponseBody(
  response: Response,
  maxArchiveBytes: number,
  deadline: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  // The fetch's signal covers the headers; a body that stops mid-stream does
  // not reject a pending read on its own, so the same deadline races it. The
  // race keeps a reaction on `expired`, so a deadline that fires after a fast
  // download rejects into a settled race, never into the void.
  let fail: () => void = () => undefined
  const expired = new Promise<never>((_resolve, reject) => {
    fail = () => reject(new PullFailure('archive_timeout'))
    if (deadline.aborted) fail()
    else deadline.addEventListener('abort', fail, { once: true })
  })
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]).catch(async error => {
        await reader.cancel().catch(() => undefined)
        throw error
      })
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxArchiveBytes) {
        await reader.cancel().catch(() => undefined)
        throw new PullFailure('recursive_limit_exceeded', false)
      }
      chunks.push(value)
    }
  } finally {
    deadline.removeEventListener('abort', fail)
  }
  const archive = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }
  return archive
}

function snapshotPath(stateDir: string, subscriptionId: string): string {
  return join(stateDir, 'marketplace', safeSubscriptionId(subscriptionId), SNAPSHOT_FILE)
}

function safeSubscriptionId(subscriptionId: string): string {
  return /^[A-Za-z\d_-]+$/.test(subscriptionId)
    ? subscriptionId
    : createHash('sha256').update(subscriptionId).digest('hex')
}

async function isRegularFile(path: string): Promise<boolean> {
  return stat(path)
    .then(entry => entry.isFile())
    .catch(() => false)
}

async function writeAtomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${SNAPSHOT_FILE}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}
