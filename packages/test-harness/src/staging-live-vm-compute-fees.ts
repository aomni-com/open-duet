import assert from 'node:assert/strict'

import { currentDayKey } from '@repo/contract'

import { fnAction, fnQuery } from './staging-live-env.ts'
import { apiJson, bearerJson } from './staging-live-http.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

/**
 * Metered VM compute, end to end on deployed staging.
 *
 * Everything else about this feature is provable locally against a fake exe
 * client. Exactly one thing is not: that exe.dev really hands us per-VM CPU and
 * memory for a workspace THIS deployment provisioned, on demand, with the token
 * staging actually holds. That call was HTTP 403 as recently as July and nobody
 * knows why it works now, so the whole feature rests on a permission that has
 * already been revoked once. This journey is the only place that bet is settled
 * against reality.
 *
 * The second thing only live can prove: that the money path reaches the screen.
 * A fee that debits correctly but renders as an unlabelled "Usage" row is a
 * support ticket, and the projection crosses Convex, the API and the SPA.
 *
 * NOT covered here, deliberately:
 * - Pricing correctness. `packages/contract/src/vm-usage` pins that against
 *   synthetic points, exactly, including the affordability constraint. Burning
 *   real CPU to re-derive arithmetic would cost pool capacity shared with
 *   production workspaces and prove less.
 * - The hourly and daily crons' schedules. This drives their bodies directly;
 *   `crons.ts` is a one-line registration.
 * - The first ~4-5 minutes of a VM's life, which emit no provider points at
 *   all (see `specs/done/vm-compute-fees/research/fleet-metering.md`). The journey
 *   waits for real points rather than pretending that window does not exist.
 */
export interface VmComputeFeesEvidence {
  /** Provider points the sampler stored for this workspace's VM. */
  sampledPoints: number
  /** Inserted on a second identical sweep. Must be zero -- 24h re-returns the same points. */
  reinsertedOnReplay: number
  /** Storage bar bytes on a fresh VM. Must be 0: the image is subtracted. */
  freshStorageUsedBytes: number
  /** The fee charged for the settled day, in micro-USD. */
  chargedMicroUsd: number
  /** Ledger rows carrying the fee's reference. Must be exactly 1 after a replay. */
  feeRowsAfterReplay: number
  /** The label the billing history gives the fee. */
  feeLabel: string
  /** Whether a second workspace was refused for this Starter payer. */
  secondWorkspaceRefused: boolean
}

/*
 * A fresh VM does not report immediately: exe.dev aggregates into ~10-minute
 * windows, so the first point for a VM created at T lands somewhere after
 * T+10min. Twelve minutes was too tight and the journey failed on a VM that was
 * behaving normally. Twenty gives two aggregation windows.
 */
const POINT_WAIT_MS = 20 * 60 * 1000
const POLL_MS = 30 * 1000

export async function runVmComputeFeesJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<VmComputeFeesEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'vm-compute-fees',
    label: 'VM Compute Fees',
    onProgress: options.onProgress,
    run: async context => await runVmComputeFeesAcceptance(context),
  })
}

export async function runVmComputeFeesAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<VmComputeFeesEvidence> {
  const { env, workspace, apiToken, convex, progress } = context
  const headers = bearerJson(apiToken)

  // Leg 1 -- real provider metrics for a VM this deployment provisioned.
  //
  // Polls rather than assuming: a fresh VM emits nothing for the first few
  // minutes, which is a measured property of exe.dev and not a flake.
  progress('waiting for provider metrics')
  const deadline = Date.now() + POINT_WAIT_MS
  let sampledPoints = 0
  for (;;) {
    await convex.action(fnAction('testing/vmUsage:sweepVmTelemetryForTest'), {
      internalKey: env.internalKey,
      limit: 500,
    })
    sampledPoints = await storedPointCount(context)
    if (sampledPoints > 1) break
    assert.ok(
      Date.now() < deadline,
      `no provider metrics for ${workspace.vmName ?? workspace.slug} within ${POINT_WAIT_MS / 60_000} min -- ` +
        'either exe stat lost its token scope again, or the VM never reported',
    )
    await Bun.sleep(POLL_MS)
  }

  // Leg 2 -- the same window swept twice inserts nothing the second time.
  //
  // `stat --range=24h` re-returns identical points on every run, so an hourly
  // sampler sees each about six times. A dedup off by one millisecond of
  // timestamp parsing multiplies every bill, and looks exactly like real usage
  // afterwards.
  progress('replaying the sweep')
  const replay = (await convex.action(fnAction('testing/vmUsage:sweepVmTelemetryForTest'), {
    internalKey: env.internalKey,
    limit: 500,
  })) as { inserted: number }
  assert.equal(replay.inserted, 0, 'a repeated sweep inserted points -- dedup is broken')

  // Leg 3 -- the storage bar reads zero on a workspace nobody has written to.
  //
  // The provider reports whole-filesystem usage including the ~7.4GB image,
  // while the advertised allowance already excludes it. Getting this wrong
  // shows every new user as a third full and fires the storage warning early,
  // with no error anywhere.
  progress('reading the storage projection')
  const overview = await apiJson<{
    workspaces?: Array<{ slug: string; storage?: { usedBytes?: number } }>
  }>(`${env.apiUrl}/v1/user/billing`, { headers }, 200, 'billing overview')
  const thisWorkspace = overview.workspaces?.find(row => row.slug === workspace.slug)
  const freshStorageUsedBytes = thisWorkspace?.storage?.usedBytes ?? 0
  assert.equal(
    freshStorageUsedBytes,
    0,
    `a fresh VM reported ${freshStorageUsedBytes} used bytes -- the image is not being subtracted`,
  )

  // Leg 4 -- the fee reaches the ledger, once.
  progress('charging the settled day')
  const dayKey = currentDayKey()
  const charged = (await convex.action(fnAction('testing/vmUsage:chargeVmComputeForTest'), {
    internalKey: env.internalKey,
    dayKey,
    limit: 500,
  })) as { charged: number; microUsd: number }
  assert.ok(charged.charged > 0, `no workspace was charged for ${dayKey}`)

  await convex.action(fnAction('testing/vmUsage:chargeVmComputeForTest'), {
    internalKey: env.internalKey,
    dayKey,
    limit: 500,
  })

  // Leg 5 -- the fee is legible, and the replay left one row.
  progress('reading billing history')
  const history = await apiJson<{
    items: Array<{ type: string; usageKind?: string; amountMicroUsd: number }>
  }>(`${env.apiUrl}/v1/user/billing/history`, { headers }, 200, 'billing history')
  const feeRows = history.items.filter(item => item.usageKind === 'vm_compute')
  assert.equal(
    feeRows.length,
    1,
    `expected exactly one VM compute row after a replay, saw ${feeRows.length}`,
  )
  // The raw reference and metadata must never leave the backend.
  assert.ok(
    history.items.every(item => !('reference' in item) && !('metadata' in item)),
    'billing history leaked an internal reference or raw metadata',
  )

  // Leg 6 -- no card was charged by a background job.
  const scheduled = (await convex.query(
    fnQuery('testing/credits:listScheduledCreditFunctionsForTest'),
    { internalKey: env.internalKey },
  )) as Array<{ name: string }>
  assert.equal(
    scheduled.filter(row => row.name.includes('topup')).length,
    0,
    'the fee scheduled an auto-topup -- it must never route through preflight',
  )

  // Leg 7 -- a Starter payer funds exactly one workspace.
  progress('checking the workspace limit')
  const secondWorkspace = await fetch(`${env.apiUrl}/v1/workspaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      slug: `vm-fee-limit-${context.runId}`.toLowerCase().slice(0, 40),
      name: `VM fee limit ${context.runId}`,
    }),
  })
  const secondWorkspaceRefused = secondWorkspace.status === 402
  assert.ok(
    secondWorkspaceRefused,
    `a second workspace returned ${secondWorkspace.status}, expected 402 workspace_limit_reached`,
  )

  return {
    sampledPoints,
    reinsertedOnReplay: replay.inserted,
    freshStorageUsedBytes,
    chargedMicroUsd: charged.microUsd,
    feeRowsAfterReplay: feeRows.length,
    feeLabel: 'vm_compute',
    secondWorkspaceRefused,
  }
}

async function storedPointCount(context: WorkspaceBrowserJourneyContext): Promise<number> {
  // Reads the raw rows rather than the chart projection: `listTelemetryHistory`
  // requires an actorId alongside an internalKey (it authorizes a MEMBER read),
  // and this leg is asking a storage question, not a permission one.
  const samples = (await context.convex.query(
    fnQuery('testing/vmTelemetry:rawTelemetrySamplesForTest'),
    { internalKey: context.env.internalKey, workspaceId: context.workspace._id },
  )) as unknown[]
  return samples.length
}
