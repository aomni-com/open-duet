import { setTimeout as sleepTimer } from 'node:timers/promises'

import {
  RuntimeReleaseEnvelopeSchema,
  VmSyncRequestSchema,
  VmSyncResponseSchema,
  type RuntimeReleaseDescriptor,
  type VmRegisterResponse,
  type VmSyncRequest,
  type VmSyncResponse,
} from '@repo/contract'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SyncDirectiveSink {
  accept(payload: VmSyncResponse): Promise<void>
  acceptRuntimeRelease(descriptor: RuntimeReleaseDescriptor): Promise<void>
}

export interface VmSyncClientOptions {
  config: {
    apiUrl?: string
    workspaceHint?: string
    fetch: FetchLike
    extraHeaders?: Record<string, string>
    sleep?: (ms: number) => Promise<void>
    log?: (fields: Record<string, unknown>) => void
    beforeSync?: (token: string) => Promise<void>
    backupPollAfterMs?: () => number | undefined
  }
  sink: SyncDirectiveSink
  getVmToken: () => Promise<string | null>
  setVmToken: (token: string) => void
  trainReports: {
    reports(): VmSyncRequest['trainReports']
    acknowledge(generations: string[]): void
  }
  syncthingDeviceId: {
    read(): Promise<string>
  }
  shareSyncReports: {
    reports(): NonNullable<VmSyncRequest['shareSyncReports']>
    acknowledge(reports: NonNullable<VmSyncRequest['shareSyncReports']>): void
  }
  marketplacePullReports: {
    reports(): NonNullable<VmSyncRequest['marketplacePullReports']>
    acknowledge(reports: NonNullable<VmSyncRequest['marketplacePullReports']>): void
  }
  appReconciliationReports: {
    reports(): NonNullable<VmSyncRequest['appReconciliationReports']>
    acknowledge(reports: NonNullable<VmSyncRequest['appReconciliationReports']>): void
  }
  reportedVersions: () => Promise<VmSyncRequest['versions']>
  needsModelCredentials: () => boolean
  needsAppCredentials: () => string[]
  registerOnce: () => Promise<VmRegisterResponse>
}

export interface VmSyncClient {
  start(): void
  wake(): void
  syncOnce(): Promise<void>
}

export function createVmSyncClient(options: VmSyncClientOptions): VmSyncClient {
  let wakeRequested = false
  let wakeSleeping: (() => void) | undefined
  function wake() {
    wakeRequested = true
    wakeSleeping?.()
  }
  async function sleep(ms: number) {
    if (wakeRequested) {
      wakeRequested = false
      return
    }
    const controller = new AbortController()
    const woken = new Promise<void>(resolve => {
      wakeSleeping = () => {
        controller.abort()
        resolve()
      }
    })
    const elapsed =
      options.config.sleep?.(ms) ??
      sleepTimer(ms, undefined, { signal: controller.signal }).catch(error => {
        if (!controller.signal.aborted) throw error
      })
    try {
      await Promise.race([elapsed, woken])
    } finally {
      controller.abort()
      wakeSleeping = undefined
      wakeRequested = false
    }
  }
  const pollDelay = (milliseconds: number) =>
    boundedPollMs(Math.min(milliseconds, options.config.backupPollAfterMs?.() ?? Infinity))
  let started = false
  let memoizedSyncthingDeviceId: string | undefined

  let pending: Promise<unknown> = Promise.resolve()

  function enqueueSync(): Promise<number> {
    const next = pending.then(runOnce)
    pending = next.catch(() => undefined)
    return next
  }

  async function runOnce(): Promise<number> {
    let token = await options.getVmToken()
    if (token === null) {
      const registered = await options.registerOnce()
      options.setVmToken(registered.vmToken)
      // Post-commit registration fallback carries the token, not a complete
      // desired snapshot. Wait for the next authenticated sync before applying.
      const snapshot = VmSyncResponseSchema.safeParse(registered.sync)
      if (snapshot.success) await options.sink.accept(snapshot.data)
      return pollDelay(registered.syncIntervalSeconds * 1000)
    }
    if (options.config.apiUrl === undefined) throw new Error('DUET_API_URL is required')
    await options.config.beforeSync?.(token)

    const trainReports = options.trainReports.reports()
    const shareSyncReports = options.shareSyncReports.reports()
    const marketplacePullReports = options.marketplacePullReports.reports()
    const appReconciliationReports = options.appReconciliationReports.reports()
    const syncthingDeviceId = await observedSyncthingDeviceId()
    const body = VmSyncRequestSchema.parse({
      ...(options.config.workspaceHint === undefined
        ? {}
        : { workspaceHint: options.config.workspaceHint }),
      trainReports,
      ...(syncthingDeviceId === undefined ? {} : { syncthingDeviceId }),
      ...(shareSyncReports.length === 0 ? {} : { shareSyncReports }),
      ...(marketplacePullReports.length === 0 ? {} : { marketplacePullReports }),
      ...(appReconciliationReports.length === 0 ? {} : { appReconciliationReports }),
      needsModelCredentials: options.needsModelCredentials(),
      needsAppCredentials: options.needsAppCredentials(),
      versions: await options.reportedVersions(),
    } satisfies VmSyncRequest)
    const response = await options.config.fetch(
      `${options.config.apiUrl.replace(/\/+$/g, '')}/v1/vm/sync`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.config.extraHeaders,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) throw new Error(`sync failed with HTTP ${response.status}`)
    const json = await response.json()
    // Anti-brick rescue (slice 08): salvage and apply runtimeRelease BEFORE the
    // full parse, so this gateway can always roll forward — even if a future
    // response shape it doesn't understand would otherwise fail validation.
    const rescue = RuntimeReleaseEnvelopeSchema.safeParse(json)
    if (rescue.success && rescue.data.runtimeRelease !== undefined) {
      await options.sink.acceptRuntimeRelease(rescue.data.runtimeRelease)
    }
    let payload: VmSyncResponse
    try {
      payload = VmSyncResponseSchema.parse(json)
    } catch (error) {
      // A rescue-only envelope (or any unparseable response) means the API
      // could not read OUR request. Log our exact request body locally —
      // it carries no secrets (the token rides the header) — so a wedged
      // VM names its own offending field instead of needing server logs.
      options.config.log?.({
        operation: 'vm_sync_request_echo',
        request: JSON.stringify(body).slice(0, 4000),
      })
      throw error
    }
    if (shareSyncReports.length > 0) options.shareSyncReports.acknowledge(shareSyncReports)
    if (marketplacePullReports.length > 0) {
      options.marketplacePullReports.acknowledge(marketplacePullReports)
    }
    if (appReconciliationReports.length > 0) {
      options.appReconciliationReports.acknowledge(appReconciliationReports)
    }
    options.trainReports.acknowledge(payload.acceptedTrainReportGenerations ?? [])
    await options.sink.accept(payload)
    return pollDelay(payload.pollAfterMs)
  }

  async function syncOnce(): Promise<void> {
    await enqueueSync()
  }

  function start(): void {
    if (started) return
    started = true
    void (async () => {
      let errorBackoffMs = 5_000
      for (;;) {
        try {
          const pollAfterMs = await enqueueSync()
          errorBackoffMs = 5_000
          await sleep(pollAfterMs)
        } catch (error) {
          options.config.log?.({
            operation: 'vm_sync',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
          await sleep(errorBackoffMs)
          errorBackoffMs = Math.min(300_000, errorBackoffMs * 2)
        }
      }
    })()
  }

  async function observedSyncthingDeviceId(): Promise<string | undefined> {
    if (memoizedSyncthingDeviceId !== undefined) return memoizedSyncthingDeviceId
    try {
      memoizedSyncthingDeviceId = await options.syncthingDeviceId.read()
      return memoizedSyncthingDeviceId
    } catch (error) {
      options.config.log?.({
        operation: 'syncthing_device_id',
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  return { start, wake, syncOnce }
}

function boundedPollMs(pollAfterMs: number): number {
  return Math.min(300_000, Math.max(1_000, pollAfterMs))
}
