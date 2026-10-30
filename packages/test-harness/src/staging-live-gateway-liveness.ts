import assert from 'node:assert/strict'

import {
  FOLD_DISTINCT_FILES,
  FileHistoryResponseSchema,
  FileOperationResponseSchema,
  FileWriteResponseSchema,
  encodeActorContext,
  type FileEventBatch,
  type FileHistoryResponse,
  type FileOperationRequest,
  type GatewayAnchor,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser'
import { fnMutation, fnQuery } from './staging-live-env'
import { apiJson, bearer, stagingFetch } from './staging-live-http'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser'

const GATEWAY_LIVENESS_OPERATIONS = [
  'rename-chain',
  'rename-over',
  'path-reuse',
  'copy',
  'delete-recreate',
  'atomic-save',
  'noisy-internal-rename',
  'noisy-boundary-rename',
  'lineage-miss',
  'folder-move',
  'restore-window',
] as const

const actor = encodeActorContext({ kind: 'system' })

/**
 * Enough that at least one delivery crosses FOLD_DISTINCT_FILES.
 *
 * Measured live: these 48 writes are separate HTTP round-trips from outside the
 * VM, so the gateway spread them across many flushes and only the fullest one
 * folded — 11 files of 48. That is a property of how slowly the journey can
 * write, not of folding: a build writing a tree inside the VM lands in one
 * flush and folds whole, which is the shape the production export showed.
 *
 * So this number buys the *existence* of a fold, and nothing about its size is
 * asserted. See `folding` in the evidence for what each run actually observed.
 */
const FOLD_BURST_FILES = 48

export function gatewayLivenessPaths(runId: string) {
  const suffix = runId.replaceAll(/[^a-zA-Z0-9-]/g, '-').slice(-24)
  const root = `gateway-liveness/${suffix}`
  return {
    root,
    authored: `${root}/authored`,
    file: `${root}/authored/renamed/final.txt`,
    git: `${root}/.git/objects/pack/a`,
    modules: `${root}/node_modules/pkg/cache/a`,
    coalesced: `${root}/authored/coalesced.txt`,
    foldedDir: `${root}/build/out`,
    movedFolder: `${root}/destination/moved`,
    movedDescendant: `${root}/destination/moved/nested/history.txt`,
  }
}

export interface GatewayLivenessEvidence {
  operations: readonly string[]
  injectedRelayFailureStatus: number
  retryBatchRows: number
  retryBatchEventRows: number
  summaryCounts: { git: number; nodeModules: number }
  /**
   * How much of a burst actually folded. Recorded rather than asserted on a
   * ratio: folding is judged per delivery, and how a burst splits into
   * deliveries is a property of how fast the writer writes, which this journey
   * cannot control from outside the VM.
   */
  folding: { burstFiles: number; foldedGroups: number; foldedFiles: number; perFileRows: number }
  projection: {
    completedSeq: number
    latestSeq: number
    lag: number
    maxOperations: number
    memberships: number
  }
  feedSizes: { root: number; exact: number; subtree: number; newParent: number }
  namespace: { lineageMisses: number }
  gatewayDiagnostics: {
    rawEventsDelta: number
    rawNudgePathsDelta: number
    retainedDescendantPath: string
    anchorFast: { walkEntries: number }
    anchorSlow: { walkEntries: number; excludedSubtrees: number }
    restoreProbe: { path: 'skipped'; skipReason: 'restore_in_flight' }
    anchorCountBefore: number
    anchorCountAfter: number
    bootHealthCertified: boolean
  }
  rollupCount: number
  movedFolderBindings: number
  cursors: string[]
  browser: { columns: number; desktopShot: string; mobileShot: string }
}

export async function runGatewayLivenessJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<GatewayLivenessEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'gateway-liveness',
    label: 'Gateway Liveness',
    onProgress: options.onProgress,
    run: runGatewayLivenessAcceptance,
  })
}

export async function runGatewayLivenessAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<GatewayLivenessEvidence> {
  const { env, workspace, apiToken, runId, convex, artifacts, page, progress } = context
  const paths = gatewayLivenessPaths(runId)
  const filesBase = `${env.apiUrl}/v1/ws/${workspace.slug}/files`
  const action = async (operation: FileOperationRequest, label: string) =>
    FileOperationResponseSchema.parse(
      await apiJson(
        `${filesBase}/actions`,
        {
          method: 'POST',
          headers: bearer(apiToken, { 'content-type': 'application/json' }),
          body: JSON.stringify(operation),
        },
        200,
        label,
        artifacts,
      ),
    )
  const write = async (path: string, contents: string, label: string) =>
    FileWriteResponseSchema.parse(
      await apiJson(
        `${filesBase}/${encodePath(path)}`,
        { method: 'PUT', headers: bearer(apiToken), body: contents },
        200,
        label,
        artifacts,
      ),
    )
  const connection = (await convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: env.internalKey, slug: workspace.slug },
  )) as { vmToken: string; httpsUrl: string } | null
  assert(connection !== null, 'gateway connection missing for liveness diagnostics')
  const diagnosticsBefore = await gatewayHealth(connection.httpsUrl, connection.vmToken)
  const anchorsBefore = (await convex.query(fnQuery('domains/anchors/model:listByWorkspace'), {
    internalKey: env.internalKey,
    workspaceId: workspace._id,
  })) as unknown[]

  progress('gateway-liveness:anchor-fast-slow')
  const anchorSlug = `liveness-${runId.slice(-8)}`
  const anchorPath = `agents/${anchorSlug}`
  await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: anchorSlug,
    name: `Liveness ${runId.slice(-8)}`,
    description: 'Gateway liveness anchor fixture.',
    ledger: context.ledger,
    convex,
    artifacts,
  })
  const gatewayAnchors = (await convex.query(fnQuery('testing/anchors:gatewayAnchorsForTest'), {
    internalKey: env.internalKey,
    workspaceId: workspace._id,
  })) as GatewayAnchor[]
  assert(
    gatewayAnchors.some(anchor => anchor.path === anchorPath),
    'fixture anchor missing',
  )
  await reconcileGatewayAnchors(connection, gatewayAnchors)
  const fastAnchorHealth = await gatewayHealth(connection.httpsUrl, connection.vmToken)
  assert.equal(fastAnchorHealth.diagnostics.anchorReconcile?.path, 'fast')
  assert.equal(fastAnchorHealth.diagnostics.anchorReconcile?.walkEntries, 0)

  progress('gateway-liveness:ordinary')
  await action(
    { operation: 'mkdir', path: paths.authored, recursive: true },
    'create authored tree',
  )
  await write(`${paths.authored}/start.txt`, runId, 'write authored file')
  await action(
    {
      operation: 'move',
      source: `${paths.authored}/start.txt`,
      destination: `${paths.authored}/middle.txt`,
      overwrite: false,
    },
    'rename chain first leg',
  )
  await action(
    { operation: 'mkdir', path: `${paths.authored}/renamed`, recursive: true },
    'rename dir',
  )
  await action(
    {
      operation: 'move',
      source: `${paths.authored}/middle.txt`,
      destination: paths.file,
      overwrite: false,
    },
    'rename chain second leg',
  )

  progress('gateway-liveness:structural-matrix')
  await write(`${paths.authored}/over-source.txt`, 'source', 'rename-over source')
  await write(`${paths.authored}/over-target.txt`, 'target', 'rename-over target')
  await action(
    {
      operation: 'move',
      source: `${paths.authored}/over-source.txt`,
      destination: `${paths.authored}/over-target.txt`,
      overwrite: true,
    },
    'rename over',
  )
  await write(`${paths.authored}/reuse.txt`, 'first', 'path reuse first identity')
  await deleteFile(filesBase, paths.authored + '/reuse.txt', apiToken, artifacts)
  await write(`${paths.authored}/reuse.txt`, 'second', 'path reuse second identity')
  await action(
    {
      operation: 'copy',
      source: paths.file,
      destination: `${paths.authored}/copy.txt`,
      recursive: false,
      overwrite: false,
    },
    'copy identity',
  )
  await write(`${paths.authored}/recreated.txt`, 'before', 'delete recreate before')
  await deleteFile(filesBase, paths.authored + '/recreated.txt', apiToken, artifacts)
  await write(`${paths.authored}/recreated.txt`, 'after', 'delete recreate after')
  await write(paths.file, 'atomic one', 'atomic save one')
  await write(paths.file, 'atomic two', 'atomic save two')

  // Folding, through the real relay. Repeated saves of one path must share a
  // row, and a burst of distinct files in one folder must collapse to one
  // summary — neither of which a fixture can prove, because the fixture is the
  // thing that synthesizes the event stream.
  progress('gateway-liveness:folding-pressure')
  for (const round of Array.from({ length: 6 }, (unused, index) => index)) {
    await write(paths.coalesced, `save-${round}`, `coalesced save ${round}`)
  }
  await Promise.all(
    Array.from({ length: FOLD_BURST_FILES }, async (unused, index) => {
      await write(`${paths.foldedDir}/chunk-${index}.js`, `chunk-${index}`, `fold burst ${index}`)
    }),
  )

  progress('gateway-liveness:noisy-pressure')
  await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      await write(
        `${paths.root}/.git/objects/pack/${index}.pack`,
        `git-${index}`,
        `git pressure ${index}`,
      )
      await write(
        `${paths.root}/node_modules/pkg/cache/${index}.js`,
        `module-${index}`,
        `module pressure ${index}`,
      )
    }),
  )
  await action(
    {
      operation: 'move',
      source: `${paths.root}/.git/objects/pack/0.pack`,
      destination: `${paths.root}/.git/objects/pack/renamed.pack`,
      overwrite: false,
    },
    'noisy internal rename',
  )
  await action(
    {
      operation: 'move',
      source: `${paths.root}/node_modules/pkg/cache/0.js`,
      destination: `${paths.authored}/boundary.js`,
      overwrite: false,
    },
    'noisy boundary rename',
  )
  const noiseHealth = await gatewayHealth(connection.httpsUrl, connection.vmToken)
  const rawNudgePathsDelta =
    noiseHealth.diagnostics.scanNudge.rawPathsObserved -
    diagnosticsBefore.diagnostics.scanNudge.rawPathsObserved
  assert(rawNudgePathsDelta >= 50, 'scan nudge did not observe every generated-tree path')
  const retainedDescendantPath = noiseHealth.diagnostics.scanNudge.latestPaths.find(path =>
    path.includes('/node_modules/pkg/cache/'),
  )
  assert(retainedDescendantPath !== undefined, 'scan nudge telemetry lost descendant paths')

  // Run the slow path only after noisy trees exist. The reconciler must walk a
  // bounded useful tree while excluding both generated subtrees.
  const displacedAnchorPath = `${anchorPath}-temporarily-missing`
  await action(
    { operation: 'move', source: anchorPath, destination: displacedAnchorPath, overwrite: false },
    'temporarily displace anchor',
  )
  await reconcileGatewayAnchors(connection, gatewayAnchors)
  const slowAnchorHealth = await gatewayHealth(connection.httpsUrl, connection.vmToken)
  const slowTelemetry = slowAnchorHealth.diagnostics.anchorReconcile
  assert.equal(slowTelemetry?.path, 'slow')
  assert(slowTelemetry.walkEntries > 0 && slowTelemetry.walkEntries < 256)
  assert(slowTelemetry.excludedSubtrees >= 2, 'slow reconcile did not exclude generated trees')
  await action(
    { operation: 'move', source: displacedAnchorPath, destination: anchorPath, overwrite: false },
    'restore displaced anchor',
  )
  await reconcileGatewayAnchors(connection, gatewayAnchors)

  const restoreProbe = await probeRestoreWindow(connection, gatewayAnchors)
  assert.equal(restoreProbe.telemetry.path, 'skipped')
  assert.equal(restoreProbe.telemetry.skipReason, 'restore_in_flight')
  assert.deepEqual(restoreProbe.reports, [])
  assert.equal(restoreProbe.restoreInFlight, false)

  progress('gateway-liveness:folder-move')
  const oldFolder = `${paths.root}/source/moved`
  await action(
    { operation: 'mkdir', path: `${oldFolder}/nested`, recursive: true },
    'nested folder',
  )
  await write(`${oldFolder}/nested/history.txt`, 'nested history', 'nested history write')
  await action(
    { operation: 'mkdir', path: `${paths.root}/destination`, recursive: true },
    'new parent',
  )
  await action(
    { operation: 'move', source: oldFolder, destination: paths.movedFolder, overwrite: false },
    'large folder move',
  )

  progress('gateway-liveness:relay-retry')
  const batchId = `gateway-liveness-${runId}`
  const retryPath = `${paths.root}/retry-idempotency.txt`
  const now = Date.now()
  const retryBatch: FileEventBatch = {
    batchId,
    droppedReads: 0,
    overflow: 0,
    events: [
      {
        kind: 'rename',
        entryKind: 'file',
        fromPath: `${paths.root}/missing-lineage.txt`,
        path: `${paths.root}/lineage-miss.txt`,
        actor,
        at: now,
      },
      { kind: 'write', path: retryPath, actor, at: now + 1 },
    ],
  }
  const failedRelay = await stagingFetch(`${env.apiUrl}/v1/vm/file-events`, {
    method: 'POST',
    headers: bearer('deliberately-invalid-token', { 'content-type': 'application/json' }),
    body: JSON.stringify(retryBatch),
  })
  assert.equal(failedRelay.status, 401, 'injected relay failure did not fail authentication')
  for (const label of ['retry delivery', 'retry replay']) {
    await apiJson(
      `${env.apiUrl}/v1/vm/file-events`,
      {
        method: 'POST',
        headers: bearer(connection.vmToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(retryBatch),
      },
      200,
      label,
      artifacts,
    )
  }

  progress('gateway-liveness:projection')
  const owner = (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
    internalKey: env.internalKey,
    email: context.email,
  })) as { _id: string } | null
  assert(owner !== null, 'journey owner disappeared before projection read')
  let maxOperations = 0
  let projection: { completedSeq: number; latestSeq: number; lag: number } | null = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projected = (await convex.mutation(
      fnMutation('testing/fileActivity:projectWorkspaceChunkForTest'),
      { internalKey: env.internalKey, workspaceId: workspace._id },
    )) as { projectionOperations: number; pending: boolean }
    maxOperations = Math.max(maxOperations, projected.projectionOperations)
    projection = (await convex.query(fnQuery('domains/fileActivity/queries:projectionStatus'), {
      internalKey: env.internalKey,
      actorId: owner._id,
      workspaceSlug: workspace.slug,
    })) as { completedSeq: number; latestSeq: number; lag: number }
    // Gateway delivery and the scheduled projector remain live while this
    // probe runs. A worker can truthfully report no work and then receive a
    // later sealed batch, so completion requires the reader watermark too.
    if (!projected.pending && projection.lag === 0) break
    if (attempt === 199) throw new Error('file activity projection did not complete')
  }
  assert(projection !== null, 'projection status was never read')
  assert.equal(projection.lag, 0, 'projection remained behind the canonical log')

  const [rootFeed, exactFeed, subtreeFeed, newParentFeed] = await Promise.all([
    activityFeed(env.apiUrl, workspace.slug, apiToken, '', undefined, artifacts),
    activityFeed(env.apiUrl, workspace.slug, apiToken, paths.file, 'exact', artifacts),
    activityFeed(env.apiUrl, workspace.slug, apiToken, paths.movedFolder, 'subtree', artifacts),
    activityFeed(
      env.apiUrl,
      workspace.slug,
      apiToken,
      `${paths.root}/destination`,
      'subtree',
      artifacts,
    ),
  ])
  assertNewestFirst(rootFeed)
  const cursors = [rootFeed.nextCursor, exactFeed.nextCursor, subtreeFeed.nextCursor].filter(
    (cursor): cursor is string => cursor !== null,
  )
  assert(cursors.length > 0, 'paginated feeds returned no cursor')
  for (const cursor of cursors) assert(cursor.length > 0, 'activity cursor was empty')
  assert(exactFeed.items.length > 0, 'renamed exact file lost its prior activity')
  assert(subtreeFeed.items.length > 0, 'moved subtree lost descendant activity')
  assert(
    !newParentFeed.items.some(
      row => 'path' in row.event && row.event.path.endsWith('nested/history.txt'),
    ),
    'folder move retroactively filled the broader new parent feed',
  )

  progress('gateway-liveness:browser-refresh')
  const addressedPath = `/w/${encodeURIComponent(workspace.slug)}/files/${encodePath(paths.movedFolder)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}${addressedPath}`)
  await page.waitForURL(url => url.pathname === addressedPath, { timeout: 60_000 })
  const columns = page.locator('[data-files-columns-pane] [data-drive-column]')
  await page.locator('[data-files-columns-pane]').waitFor({ timeout: 60_000 })
  assert((await columns.count()) >= 2, 'deep folder route did not keep multiple columns visible')
  await Promise.all([
    write(`${paths.root}/ancestor-refresh.txt`, 'ancestor', 'ancestor column refresh'),
    write(`${paths.movedFolder}/refresh.txt`, 'descendant', 'descendant column refresh'),
  ])
  await columns
    .filter({ has: page.getByText('ancestor-refresh.txt', { exact: true }) })
    .waitFor({ timeout: 45_000 })
  await columns
    .filter({ has: page.getByText('refresh.txt', { exact: true }) })
    .waitFor({ timeout: 45_000 })
  const desktopShot = `${artifacts.directory}/gateway-liveness-desktop.png`
  await page.screenshot({ path: desktopShot, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(
    () => {
      const scroller = document.querySelector<HTMLElement>('[data-drive-columns]')
      const terminal = scroller?.lastElementChild
      if (scroller === null || !(terminal instanceof HTMLElement)) return false
      const viewport = scroller.getBoundingClientRect()
      const column = terminal.getBoundingClientRect()
      return (
        Math.abs(column.left - viewport.left) <= 1 && Math.abs(column.width - viewport.width) <= 1
      )
    },
    undefined,
    { timeout: 15_000 },
  )
  const mobileShot = `${artifacts.directory}/gateway-liveness-mobile.png`
  await page.screenshot({ path: mobileShot, fullPage: true })

  const [events, access, batches, namespace, rawProjection, anchorsAfter] = await Promise.all([
    convex.query(fnQuery('testing/fileActivity:rawFileEventsForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    }) as Promise<
      Array<{
        seq: number
        kind: string
        path?: string
        count?: number
        entityId?: string
        entryKind?: 'file' | 'folder'
      }>
    >,
    convex.query(fnQuery('testing/fileActivity:rawFileAccessForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    }) as Promise<Array<{ entityId: string; writeCount: number }>>,
    convex.query(fnQuery('testing/fileActivity:rawFileEventBatchesForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    }) as Promise<Array<{ batchId: string }>>,
    convex.query(fnQuery('testing/fileActivity:rawFileActivityNamespaceForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    }) as Promise<{ lineageMisses: number }>,
    convex.query(fnQuery('testing/fileActivity:rawProjectionForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    }) as Promise<{ scopes: unknown[] }>,
    convex.query(fnQuery('domains/anchors/model:listByWorkspace'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    }) as Promise<unknown[]>,
  ])
  const retryBatchRows = batches.filter(row => row.batchId === batchId).length
  assert.equal(retryBatchRows, 1, 'stable relay batch was recorded more than once')
  const retryBatchEventRows = events.filter(
    row => row.path === retryPath && row.kind === 'write',
  ).length
  assert.equal(retryBatchEventRows, 1, 'stable relay retry inserted duplicate canonical events')
  const gitSummary = events
    .filter(row => row.path === `${paths.root}/.git` && row.count !== undefined)
    .reduce((sum, row) => sum + (row.count ?? 0), 0)
  const modulesSummary = events
    .filter(row => row.path === `${paths.root}/node_modules` && row.count !== undefined)
    .reduce((sum, row) => sum + (row.count ?? 0), 0)
  assert(gitSummary >= 24, 'git pressure did not persist as counted summaries')
  assert(modulesSummary >= 24, 'node_modules pressure did not persist as counted summaries')
  // Two kinds of summary now exist and their counts are in different units. A
  // GATEWAY fold of a regenerable tree counts raw events, which is what the
  // fileAccess rollup counts too, so those two still have to agree exactly. A
  // SERVER fold counts distinct files and deliberately does not — comparing it
  // against the rollup would assert that folding never happened.
  const gatewayFolds = events.filter(
    row => row.kind === 'changed-summary' && row.entryKind !== 'folder',
  )
  const gatewayFoldEntities = new Set(
    gatewayFolds.filter(row => row.entityId !== undefined).map(row => String(row.entityId)),
  )
  const persistedSummaryCount = gatewayFolds.reduce((sum, row) => sum + (row.count ?? 0), 0)
  const rollupCount = access
    .filter(row => gatewayFoldEntities.has(String(row.entityId)))
    .reduce((sum, row) => sum + row.writeCount, 0)
  assert.equal(
    rollupCount,
    persistedSummaryCount,
    'gateway-folded summary counts disagreed with the rollup',
  )

  // Folding, end to end. Only a real VM can show these: the fixtures upstream
  // synthesize the event stream that fanotify actually produces, and that
  // stream is the whole subject.
  const serverFolds = events.filter(
    row => row.kind === 'changed-summary' && row.entryKind === 'folder',
  )
  for (const fold of serverFolds) {
    const files = fold.count ?? 0
    assert(
      files > FOLD_DISTINCT_FILES,
      `server fold of ${String(fold.path)} carried ${files} files, at or below the threshold`,
    )
  }
  assert(
    serverFolds.some(row => row.path === paths.foldedDir),
    'a burst of distinct files did not fold to its folder',
  )
  // How MUCH folded is deliberately not asserted. These writes arrive as
  // separate HTTP round-trips from outside the VM, so they land across many
  // gateway flushes and only the fullest one crosses the threshold — measured
  // live at 11 of 48. A real burst (a build writing a tree inside the VM in
  // milliseconds) lands in one flush and folds whole, which is the shape the
  // production export showed. The ratio is therefore a property of the writer's
  // pace, not of folding, and it is recorded as evidence instead.
  const foldedDirRows = events.filter(
    row => row.path !== undefined && row.path.startsWith(`${paths.foldedDir}/`),
  ).length
  const foldedFiles = serverFolds
    .filter(row => row.path === paths.foldedDir)
    .reduce((sum, row) => sum + (row.count ?? 0), 0)
  // Repeated saves of one file share a row through the real relay, whatever the
  // watcher reported for them.
  const coalescedRows = events.filter(row => row.path === paths.coalesced && row.kind === 'write')
  assert.equal(coalescedRows.length, 1, 'repeated saves of one file did not share a bucket row')
  const movedFolderEvent = events.find(
    row => row.kind === 'rename' && row.path === paths.movedFolder && 'entityId' in row,
  ) as { entityId?: string } | undefined
  assert(movedFolderEvent?.entityId !== undefined, 'folder move event omitted its stable entity')
  const movedFolderBindings = (
    (await convex.query(fnQuery('testing/fileActivity:rawFileActivityBindingsForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
      entityId: movedFolderEvent.entityId,
    })) as unknown[]
  ).length
  assert.equal(movedFolderBindings, 2, 'folder move did not change exactly one direct binding')

  const diagnosticsAfter = await waitForCertifiedGateway(connection)
  const rawEventsDelta =
    diagnosticsAfter.diagnostics.attribution.rawEventsObserved -
    diagnosticsBefore.diagnostics.attribution.rawEventsObserved
  assert(rawEventsDelta >= 48, 'gateway diagnostics did not observe the generated-tree storm')
  assert.equal(
    anchorsAfter.length,
    anchorsBefore.length + 1,
    'generated-tree pressure or one slow reconcile falsely reaped the fixture anchor',
  )
  assert(
    diagnosticsAfter.diagnostics.anchorReconcile !== null,
    'anchor reconcile emitted no telemetry',
  )
  assert.equal(diagnosticsAfter.diagnostics.bootHealthCertified, true)

  return {
    operations: GATEWAY_LIVENESS_OPERATIONS,
    injectedRelayFailureStatus: failedRelay.status,
    retryBatchRows,
    retryBatchEventRows,
    summaryCounts: { git: gitSummary, nodeModules: modulesSummary },
    folding: {
      burstFiles: FOLD_BURST_FILES,
      foldedGroups: serverFolds.length,
      foldedFiles,
      perFileRows: foldedDirRows,
    },
    projection: {
      ...projection,
      maxOperations,
      memberships: rawProjection.scopes.length,
    },
    feedSizes: {
      root: rootFeed.items.length,
      exact: exactFeed.items.length,
      subtree: subtreeFeed.items.length,
      newParent: newParentFeed.items.length,
    },
    namespace: { lineageMisses: namespace.lineageMisses },
    gatewayDiagnostics: {
      rawEventsDelta,
      rawNudgePathsDelta,
      retainedDescendantPath,
      anchorFast: { walkEntries: fastAnchorHealth.diagnostics.anchorReconcile.walkEntries },
      anchorSlow: {
        walkEntries: slowTelemetry.walkEntries,
        excludedSubtrees: slowTelemetry.excludedSubtrees,
      },
      restoreProbe: {
        path: restoreProbe.telemetry.path,
        skipReason: restoreProbe.telemetry.skipReason,
      },
      anchorCountBefore: anchorsBefore.length,
      anchorCountAfter: anchorsAfter.length,
      bootHealthCertified: diagnosticsAfter.diagnostics.bootHealthCertified,
    },
    rollupCount,
    movedFolderBindings,
    cursors,
    browser: {
      columns: await columns.count(),
      desktopShot,
      mobileShot,
    },
  }
}

interface GatewayHealth {
  diagnostics: {
    attribution: { rawEventsObserved: number }
    scanNudge: { scans: number; rawPathsObserved: number; latestPaths: string[] }
    anchorReconcile: null | {
      path: 'fast' | 'slow' | 'skipped'
      walkEntries: number
      excludedSubtrees: number
      skipReason?: 'drive_unreadable' | 'restore_in_flight'
    }
    restoreInFlight: boolean
    bootHealthCertified: boolean
  }
}

interface RestoreWindowProbe {
  reports: unknown[]
  telemetry: { path: 'skipped'; skipReason: 'restore_in_flight' }
  restoreInFlight: boolean
}

async function probeRestoreWindow(
  connection: { httpsUrl: string; vmToken: string },
  anchors: GatewayAnchor[],
): Promise<RestoreWindowProbe> {
  const response = await stagingFetch(
    `${connection.httpsUrl.replace(/\/+$/, '')}/v1/diagnostics/restore-window`,
    {
      method: 'POST',
      headers: bearer(connection.vmToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ anchors }),
    },
  )
  assert.equal(response.status, 200, 'restore-window diagnostic probe failed')
  return (await response.json()) as RestoreWindowProbe
}

async function reconcileGatewayAnchors(
  connection: { httpsUrl: string; vmToken: string },
  anchors: GatewayAnchor[],
): Promise<void> {
  const response = await stagingFetch(
    `${connection.httpsUrl.replace(/\/+$/, '')}/v1/anchors/reconcile`,
    {
      method: 'POST',
      headers: bearer(connection.vmToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ anchors }),
    },
  )
  assert.equal(response.status, 200, 'direct gateway anchor reconcile failed')
}

async function gatewayHealth(url: string, token: string): Promise<GatewayHealth> {
  const response = await stagingFetch(`${url.replace(/\/+$/, '')}/health`, {
    headers: bearer(token),
  })
  assert.equal(response.status, 200, 'gateway health diagnostics were unavailable')
  return (await response.json()) as GatewayHealth
}

async function waitForCertifiedGateway(connection: {
  httpsUrl: string
  vmToken: string
}): Promise<GatewayHealth> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await gatewayHealth(connection.httpsUrl, connection.vmToken)
    if (health.diagnostics.bootHealthCertified) return health
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }
  throw new Error('running gateway release was not boot-health certified within 90 seconds')
}

async function activityFeed(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  path: string,
  scope: 'exact' | 'subtree' | undefined,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
  limit = 1,
): Promise<FileHistoryResponse> {
  const url = new URL(`${apiUrl}/v1/ws/${workspaceSlug}/file-activity/feed`)
  url.searchParams.set('order', 'desc')
  url.searchParams.set('limit', String(limit))
  if (path !== '') url.searchParams.set('path', path)
  if (scope !== undefined) url.searchParams.set('scope', scope)
  return FileHistoryResponseSchema.parse(
    await apiJson(url.toString(), { headers: bearer(token) }, 200, 'activity feed', artifacts),
  )
}

async function deleteFile(
  filesBase: string,
  path: string,
  token: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<void> {
  await apiJson(
    `${filesBase}/${encodePath(path)}`,
    { method: 'DELETE', headers: bearer(token) },
    200,
    `delete ${path}`,
    artifacts,
  )
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function assertNewestFirst(response: FileHistoryResponse): void {
  for (let index = 1; index < response.items.length; index += 1) {
    assert(
      response.items[index - 1]!.seq > response.items[index]!.seq,
      'activity feed was not newest-first',
    )
  }
}
