import { MAX_VM_IDLE_SYNC_INTERVAL_MS, type VmSyncRequest } from '@repo/contract'

/**
 * The sync poll is also the VM's heartbeat, and a workspace whose last
 * heartbeat is older than `VM_SYNC_STALE_MS` is swept to `unhealthy`. The idle
 * cadence therefore has a ceiling that is not about CPU at all — and it is
 * derived from that window in the contract rather than restated here, so
 * raising one cannot silently outrun the other.
 */
export const MAX_VM_IDLE_SYNC_INTERVAL_SECONDS = MAX_VM_IDLE_SYNC_INTERVAL_MS / 1_000

/** What the workspace has outstanding, as judged where the response is built. */
export interface VmSyncActivity {
  /** Agent input is parked for the next poll to deliver. */
  hasPendingRunnerInput: boolean
  /**
   * The control plane will not grant this workspace credentials — it is
   * paused or banned. A VM in that state asks for them on every poll, and a
   * request whose answer is always no is not an exchange. A suppressor, never
   * a reason: it is what keeps a paused fleet off the fast cadence.
   */
  credentialsRefused: boolean
  /** This response carries credentials the VM could not use before now. */
  deliveringModelCredentials: boolean
  /** Earliest time a credential-cap retry can make forward progress. */
  modelCredentialsRetryAt?: number
}

/**
 * How long the VM should wait before syncing again.
 *
 * Nothing a person waits on rides this interval — sessions, app installs,
 * anchor moves and provider connects are pushed straight to the gateway — so a
 * workspace with nothing outstanding is asked to come back later rather than
 * twenty times a minute forever. Anything in flight, in either direction,
 * restores the fast cadence: an in-flight report means the VM is mid-exchange.
 *
 * Runtime version drift is deliberately not activity. Each response already
 * carries the desired release; adoption waits for live work to finish. An
 * update failure must not pin an otherwise quiet VM to the fast cadence.
 */
/** What the cadence decision sees: this poll's request, and what is outstanding. */
export interface VmSyncCadenceInput {
  now: number
  activity: VmSyncActivity
  request: Pick<
    VmSyncRequest,
    | 'needsModelCredentials'
    | 'needsAppCredentials'
    | 'trainReports'
    | 'appReconciliationReports'
    | 'marketplacePullReports'
    | 'shareSyncReports'
  >
}

export function vmSyncPollAfterMs(
  input: VmSyncCadenceInput & { activeSeconds: number; idleSeconds: number },
): number {
  const activeMs = input.activeSeconds * 1_000
  if (fastCadenceReason(input) !== null) return activeMs
  const idleMs = Math.min(input.idleSeconds, MAX_VM_IDLE_SYNC_INTERVAL_SECONDS) * 1_000
  if (
    input.activity.modelCredentialsRetryAt !== undefined &&
    input.activity.modelCredentialsRetryAt > input.now
  ) {
    return Math.max(activeMs, Math.min(idleMs, input.activity.modelCredentialsRetryAt - input.now))
  }
  // A shorter idle interval than the active one would be a misconfiguration
  // that slows nothing down; the fast cadence is the floor.
  return Math.max(activeMs, idleMs)
}

/** Why a poll stays on the fast cadence, as the log names it. */
export type FastCadenceReason =
  | 'pending_runner_input'
  | 'delivering_model_credentials'
  | 'needs_model_credentials'
  | 'needs_app_credentials'
  | 'train_reports'
  | 'app_reconciliation_reports'
  | 'marketplace_pull_reports'
  | 'share_sync_reports'

/**
 * The clause that keeps this poll on the fast cadence, or null when nothing is
 * outstanding. The decision and the diagnosis are one function: the route logs
 * the reason on every fast poll, and that log is the only way production can
 * say which condition is pinning a VM. A VM pinned fast costs six times an idle
 * one, so the distribution of these reasons is the first thing to read before
 * touching the policy above.
 */
export function fastCadenceReason(input: VmSyncCadenceInput): FastCadenceReason | null {
  const { activity, request, now } = input
  if (activity.hasPendingRunnerInput) return 'pending_runner_input'
  if (activity.deliveringModelCredentials) return 'delivering_model_credentials'
  if (
    request.needsModelCredentials &&
    !activity.credentialsRefused &&
    (activity.modelCredentialsRetryAt === undefined || activity.modelCredentialsRetryAt <= now)
  ) {
    return 'needs_model_credentials'
  }
  if (!activity.credentialsRefused && (request.needsAppCredentials?.length ?? 0) > 0) {
    return 'needs_app_credentials'
  }
  if ((request.trainReports?.length ?? 0) > 0) return 'train_reports'
  if ((request.appReconciliationReports?.length ?? 0) > 0) return 'app_reconciliation_reports'
  if ((request.marketplacePullReports?.length ?? 0) > 0) return 'marketplace_pull_reports'
  if ((request.shareSyncReports?.length ?? 0) > 0) return 'share_sync_reports'
  return null
}
