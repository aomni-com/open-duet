import { cronJobs, makeFunctionReference, type FunctionReference } from 'convex/server'

const crons = cronJobs()

crons.interval(
  'verify and clean up app custom domains',
  { minutes: 1 },
  fnMutation('domains/customDomains/work:dispatchDue'),
  {},
)

crons.interval(
  'mark stale workspace sync observations',
  { minutes: 1 },
  fnMutation('domains/workspaces/provisioning:markUnhealthyWorkspaces'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.interval(
  'decommission unserviced workspaces',
  { hours: 1 },
  fnAction('domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.interval(
  'expire lapsed subscriptions and trials',
  { minutes: 1 },
  fnMutation('domains/credits/internal:expireLapsedSubscriptions'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
    limit: 100,
    useStoredCursor: true,
  },
)

crons.interval(
  'sweep missed model gateway charges',
  { minutes: 5 },
  fnMutation('domains/modelGateway/model:sweepMissedCharges'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// Folds newly settled model calls into the operator's cost-vs-billed rollup.
// A full batch chains itself, so this also backfills history on first run.
crons.interval(
  'fold settled model calls into the inference margin rollup',
  { minutes: 5 },
  fnMutation('domains/modelGateway/model:foldInferenceMargin'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// The ONE writer of listing availability. Publishers go dark by ordinary
// lifecycle — servicing decommission, archival, deletion, unpublish — so the
// catalog has to re-derive it rather than wait for a subscriber to report a
// failed pull, which would let one hostile installer grey out a rival.
crons.interval(
  'refresh marketplace listing availability',
  { minutes: 15 },
  fnMutation('domains/marketplace/listings:sweepListingAvailability'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// Separate from availability because its cost per listing is unbounded — it
// reads the publisher's whole app list — so it spends a read budget and rotates
// on its own stamp. Folding it into the availability sweep made one pass cost
// O(listings x publisher apps), which can exceed a Convex transaction's read
// ceiling and fail the ENTIRE pass, stalling the catalog silently.
crons.interval(
  'refresh marketplace listing app declarations',
  { minutes: 15 },
  fnMutation('domains/marketplace/listings:sweepListingAppDeclarations'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.interval(
  'sweep leaked workspace VM teardowns',
  { minutes: 5 },
  fnMutation('domains/workspaces/provisioning:sweepLeakedWorkspaceVmTeardowns'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.interval(
  'recover orphaned session deletion disposal runs',
  { minutes: 5 },
  fnAction('domains/agentSessions/deletionExternal:recoverSessionDeletionExternalRuns'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// The tier resource policy in @repo/contract governs new provisions only —
// changing it does nothing for a VM that already exists. This is the
// self-healing half: it re-checks every live workspace's actual allocated
// size against the current floor and raises any that fall short, so a future
// floor change (David's plan for it) reaches the whole fleet, not just new
// workspaces, without a one-off manual resize. Every resize restarts the VM.
crons.interval(
  'resize undersized workspace VMs to the current floor',
  { hours: 3 },
  fnAction('domains/workspaces/vmSize:reconcileWorkspaceVmSizes'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// The scheduled deletion behind login-as `ephemeral`: erases every disposable
// identity whose expiry has passed — owned workspaces through the real
// deletion path (the VM-teardown sweep above reclaims the VMs), then the
// identity itself. A cron rather than a per-mint scheduled function so a
// failed deletion retries every tick; up to 3h of lag past expiry is fine
// against 6–24h lifetimes (David's call).
crons.interval(
  'retire expired ephemeral identities',
  { hours: 3 },
  fnMutation('domains/users/ephemeralModel:retireExpiredEphemeralUsers'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// Provider-side metering. Hourly against a 24h window is ~6x redundant by
// design: `stat --range=24h` re-returns the same points every run, and dedup on
// the provider timestamp is what makes that safe. Sampling more often costs
// calls and buys nothing -- the provider emits every ~10 minutes.
crons.interval(
  'sample workspace VM usage from the provider',
  { hours: 1 },
  fnAction('domains/workspaces/vmUsage:sweepWorkspaceVmTelemetry'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

// Bills the PREVIOUS UTC day, twenty minutes past midnight so the hourly
// sampler's 00:0x run has landed and the day is genuinely closed. Teardown
// charges the current partial day instead, so the two can never collide on a
// reference.
crons.daily(
  'charge workspace vm compute',
  { hourUTC: 0, minuteUTC: 20 },
  fnAction('domains/workspaces/vmUsage:chargeWorkspaceVmCompute'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.daily(
  'prune daily billing usage reports',
  { hourUTC: 4, minuteUTC: 15 },
  fnMutation('domains/credits/internal:pruneDailyUsage'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.daily(
  'prune file activity past retention',
  { hourUTC: 4, minuteUTC: 45 },
  fnMutation('domains/fileActivity/retention:pruneFileEvents'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

crons.daily(
  'prune vm telemetry samples',
  { hourUTC: 4, minuteUTC: 30 },
  fnMutation('domains/workspaces/vmTelemetry:pruneTelemetrySamples'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)

/* Weekly workspace snapshots are OFF (David, 2026-08-10). Do not simply
   uncomment this: the backup design is broken, and re-enabling it needs a
   rework, not a restored registration.

   It never actually ran. `ExeClient.copy` passed `--copy-tags true` as two
   args, exe.dev read `true` as the positional new-name, and rejected every
   `cp` with a usage error -- so each weekly pass logged one failure per
   workspace and created nothing. A read-only `exe ls` on 2026-08-10 found 0
   VMs matching `*-snapshot-*`. That bug was load-bearing: it is the only
   reason the defects below never reached a user, and 3d9ea7b6 has since
   repaired the flag -- so the accident no longer protects us, and this
   registration is what keeps the job off.

   What has to be reworked first:

   - A copy is a *running peer VM*, not an image. exe.dev has no snapshot
     primitive; `cp` boots the clone (see packages/exe/scripts/probe-cp-
     semantics.ts, which reaches SSH on the clone with no start call), and
     `ExeClient` has no stop/pause -- only `restart` and `rm`. Every retained
     snapshot burns pool CPU and RAM for the whole week it exists.
   - The clone phones home as the workspace it copied. `cp` duplicates the
     disk, including `stateDir/vm-token`, so the clone's sync client finds a
     token, skips registration, and POSTs /v1/vm/sync under the live VM's
     identity (packages/gateway/src/vm/sync-client.ts). Two VMs answer for one
     workspace: duplicate heartbeats, and a second syncthing peer offering a
     week-stale Drive into the live folder. That risks corrupting user files,
     which is a worse outcome than having no backup.
   - Retention is two clones per active workspace, not one (`recordSnapshotImpl`
     keeps `[new, previous]`), bounded only by the 1000-row sweep cap.
   - Nothing ever collects them. Teardown removes `workspace.vmName` alone;
     `snapshotVmNames` is read only by this cron's own stale-delete loop, so a
     deleted workspace orphans its copies permanently -- on an exe.dev account
     shared by staging and prod, where a name-pattern sweep is unsafe.
   - `cp` is crash-consistent only for fsync'd writes; buffered writes in the
     source can roll back in the copy.

   The action (`provisioningActions:snapshotActiveWorkspaces`) is left exported
   and callable so the rework has something to start from.

crons.weekly(
  'copy active workspace snapshots',
  { dayOfWeek: 'sunday', hourUTC: 3, minuteUTC: 0 },
  fnAction('domains/workspaces/provisioningActions:snapshotActiveWorkspaces'),
  {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  },
)
*/

export default crons

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}

function fnAction(name: string): FunctionReference<'action'> {
  return makeFunctionReference(name) as FunctionReference<'action'>
}
