import { ConvexHttpClient } from 'convex/browser'

import { fnMutation, fnQuery, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { errorMessage } from './staging-live-http.ts'
import { waitForWorkspace } from './staging-live-streaming.ts'

export type StagingResourceKind =
  | 'user'
  | 'workspace'
  | 'backup'
  | 'invite'
  | 'share'
  | 'session'
  | 'agent'
  | 'official-agent-subscription'
  | 'app'
  | 'app-domain'
  | 'file'
  | 'publish'
  | 'train-job'
  | 'integration'
  | 'api-key'
  | 'sync-machine'
  | 'device-code'
  | 'oauth-client'
  | 'oauth-grant'
  | 'oauth-refresh'
  | 'service-pool'
  | 'stripe-session'
  | 'stripe-customer'
  | 'stripe-test-clock'
  | 'stripe-subscription'
  | 'stripe-subscription-schedule'
  | 'stripe-invoice'
  | 'stripe-portal-session'
  | 'mail-message'

export interface StagingResourceSnapshot {
  kind: StagingResourceKind
  id: string
  label: string
  recordedAt: number
  status: 'recorded' | 'deleted' | 'orphaned'
  error?: string
}

export interface StagingCleanupReport {
  runId: string
  status: 'pass' | 'fail'
  resources: StagingResourceSnapshot[]
  orphans: Array<Pick<StagingResourceSnapshot, 'kind' | 'id' | 'label'>>
}

interface ResourceRegistration {
  kind: StagingResourceKind
  id: string
  label: string
  cleanup: () => Promise<unknown>
  verify: () => Promise<boolean>
  /** Higher priorities clean first; identities use a negative priority so containers go first. */
  cleanupPriority?: number
}

interface TrackedResource extends ResourceRegistration {
  recordedAt: number
  status: StagingResourceSnapshot['status']
  error?: string
}

/** ~20s of grace, which is well past any settling seen in practice. */
const VERIFY_ATTEMPTS = 10
const VERIFY_RETRY_MS = 2_000

export class StagingResourceLedger {
  readonly #resources: TrackedResource[] = []
  readonly #ids = new Set<string>()

  constructor(
    readonly runId: string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms),
  ) {}

  record(resource: ResourceRegistration): void {
    if (!resource.label.includes(this.runId)) {
      throw new Error(`Synthetic resource label must contain run id ${this.runId}`)
    }
    const identity = `${resource.kind}:${resource.id}`
    if (this.#ids.has(identity)) throw new Error(`Resource ${identity} was already recorded`)
    this.#ids.add(identity)
    this.#resources.push({ ...resource, recordedAt: this.now(), status: 'recorded' })
  }

  snapshot(): StagingResourceSnapshot[] {
    return this.#resources.map(resource => ({
      kind: resource.kind,
      id: resource.id,
      label: resource.label,
      recordedAt: resource.recordedAt,
      status: resource.status,
      ...(resource.error === undefined ? {} : { error: resource.error }),
    }))
  }

  async cleanupAll(): Promise<StagingCleanupReport> {
    const cleanupOrder = [...this.#resources]
      .map((resource, index) => ({ resource, index }))
      .sort(
        (left, right) =>
          (right.resource.cleanupPriority ?? 0) - (left.resource.cleanupPriority ?? 0) ||
          right.index - left.index,
      )
      .map(({ resource }) => resource)
    for (const resource of cleanupOrder) {
      try {
        await resource.cleanup()
      } catch (error) {
        resource.error = errorMessage(error)
      }
    }

    for (const resource of cleanupOrder) {
      let deleted = false
      // Poll rather than sample. A provider is entitled to take a moment to
      // stop reporting something we just deleted, and AgentMail does — so a
      // single check made the verdict depend on how much unrelated cleanup ran
      // between the delete and the look, which is not a property of whether
      // the resource is gone.
      let verifyError: string | undefined
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS && !deleted; attempt += 1) {
        if (attempt > 0) await this.sleep(VERIFY_RETRY_MS)
        try {
          deleted = await resource.verify()
          verifyError = undefined
        } catch (error) {
          verifyError = `cleanup verification failed: ${errorMessage(error)}`
        }
      }
      // A cleanup that threw stays reported even if the resource turns out to
      // be gone: the run still did something it could not account for.
      if (verifyError !== undefined) resource.error ??= verifyError

      resource.status = deleted ? 'deleted' : 'orphaned'
      if (!deleted && resource.error === undefined) resource.error = 'cleanup could not be verified'
    }

    const resources = this.snapshot()
    const orphans = resources
      .filter(resource => resource.status === 'orphaned')
      .map(({ kind, id, label }) => ({ kind, id, label }))
    return {
      runId: this.runId,
      status:
        orphans.length === 0 && resources.every(resource => resource.error === undefined)
          ? 'pass'
          : 'fail',
      resources,
      orphans,
    }
  }
}

export function recordWorkspaceCleanup(args: {
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  env: Pick<LiveEnv, 'internalKey'>
  output: { vmNames: string[] }
  workspaceId: string
  slug: string
}): void {
  args.ledger.record({
    kind: 'workspace',
    id: args.workspaceId,
    label: `${args.ledger.runId}:workspace:${args.slug}`,
    cleanup: async () => {
      const deleted = (await args.convex.mutation(
        fnMutation('testing/workspaces:deleteWorkspaceByIdForTest'),
        { internalKey: args.env.internalKey, workspaceId: args.workspaceId },
      )) as { vmName?: string }
      if (deleted.vmName !== undefined && !args.output.vmNames.includes(deleted.vmName)) {
        args.output.vmNames.push(deleted.vmName)
      }
      await waitForWorkspace(
        args.convex,
        args.env.internalKey,
        args.workspaceId,
        row =>
          row.status === 'deleted' && row.vmName === undefined && row.vmTeardownRunId === undefined,
        240_000,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.workspaceId),
  })
}

export async function workspaceIsDeleted(
  convex: ConvexHttpClient,
  internalKey: string,
  workspaceId: string,
): Promise<boolean> {
  const workspace = (await convex.query(fnQuery('testing/workspaces:rawWorkspaceByIdForTest'), {
    internalKey,
    workspaceId,
  })) as Workspace | null
  return (
    workspace?.status === 'deleted' &&
    workspace.vmName === undefined &&
    workspace.vmTeardownRunId === undefined
  )
}
