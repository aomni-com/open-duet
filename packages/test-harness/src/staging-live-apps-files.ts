import assert from 'node:assert/strict'
import path from 'node:path'

import { type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import {
  AppListResponseSchema,
  AppResponseSchema,
  FileListResponseSchema,
  FileOperationResponseSchema,
  ROOT_AGENT_SCOPE,
  MAX_VM_IDLE_SYNC_INTERVAL_MS,
  type App,
  type FileEntry,
  type FileOperationRequest,
} from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForFinishedBrowserResponse } from './staging-live-browser-response.ts'
import {
  markExpectedBrowserTransition,
  markExpectedViewportChange,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import type { LiveEnv, Workspace } from './staging-live-env.ts'
import { apiText, bearer, bearerJson, stagingFetch, timedFetch } from './staging-live-http.ts'
import { StagingResourceLedger, workspaceIsDeleted } from './staging-live-resource-ledger.ts'

const HELLO_SLUG = 'hello'
const INITIAL_HELLO_PATH = 'welcome/hello-app'
const RENAMED_HELLO_PATH = 'welcome/hello2'
const UI_REPAIR_HELLO_PATH = 'welcome/hello-repaired'
const DIRECT_REPAIR_HELLO_PATH = 'welcome/hello-final'
/**
 * Two rails, two budgets, and the first one is paced by the idle poll.
 *
 * A folder rename travels twice: the anchor rail notices the folder moved and
 * follows it, then the app is served again from where it landed. One budget for
 * both called the total "about one 5s sync tick", so an app taking its time to
 * restart was reported as a slow sync.
 *
 * 3s is the ACTIVE cadence, and a workspace whose drive a person is rearranging
 * has no `fastCadenceReason` — no parked runner input, no credentials in
 * flight, no component drift — so it is asked to come back on the idle cadence
 * instead, which the control plane caps at a third of the staleness window.
 * A quiet workspace can therefore take one idle poll — five minutes — to
 * notice the change, and this journey waits that long. The bound is derived from the
 * window rather than guessed at, and it still fails if the rail stops following
 * folders at all.
 */
const IDLE_SYNC_CEILING_MS = MAX_VM_IDLE_SYNC_INTERVAL_MS
const ANCHOR_ADOPTION_BUDGET_MS = IDLE_SYNC_CEILING_MS + 10_000
const APP_RENAME_CONVERGENCE_BUDGET_MS = ANCHOR_ADOPTION_BUDGET_MS + 50_000
// The anchor rail needs the drive to report the folder missing several polls
// running before it deletes the row, and the idle sync cadence is 30s. Generous
// on purpose: this waits for a convergence, not for a request.
const APP_REAP_BUDGET_MS = 180_000
const SEEDED_WELCOME_ENTRIES = [
  'README.md:file',
  'clip.mp4:file',
  'deck.pptx:file',
  'hello-app:directory',
  'sample.pdf:file',
] as const

export interface FreshWorkspaceAppEvidence {
  app: App
}

export interface AppsInFilesAcceptanceEvidence {
  appId: string
  initialPath: string
  renamedPath: string
  uiRepairPath: string
  directRepairPath: string
  renameConvergenceMs: number
  anchorAdoptionMs: number
  screenshots: {
    desktop: string
    mobile: string
  }
}

export async function verifyFreshWorkspaceAppsAndFilesApi(args: {
  env: Pick<LiveEnv, 'apiUrl'>
  workspace: Workspace
  apiToken: string
  artifacts: StagingArtifactCollector
}): Promise<FreshWorkspaceAppEvidence> {
  const { env, workspace, apiToken, artifacts } = args
  const headers = bearer(apiToken)
  const app = await waitForFreshWorkspaceSeed({
    load: async () => {
      const [rootFiles, welcomeFiles, welcomeApps, rootApps, directApp] = await Promise.all([
        loadFileList(env, workspace.slug, '', headers, artifacts),
        loadFileList(env, workspace.slug, 'welcome', headers, artifacts),
        loadApps(env, workspace.slug, { path: 'welcome', scope: 'subtree' }, headers, artifacts),
        loadApps(env, workspace.slug, { path: '', scope: 'children' }, headers, artifacts),
        loadApp(env, workspace.slug, HELLO_SLUG, headers, artifacts),
      ])
      return {
        rootEntries: rootFiles.items,
        welcomeEntries: welcomeFiles.items,
        welcomeApps: welcomeApps.items,
        rootApps: rootApps.items,
        directApp: directApp.app,
      }
    },
  })

  const invalid = await timedFetch(
    appsUrl(env.apiUrl, workspace.slug, { scope: 'children' }),
    { headers },
    artifacts,
  )
  assert.equal(invalid.status, 400, 'apps scope without path did not return HTTP 400')
  assert.deepEqual(await invalid.json(), { error: 'invalid_request' })
  return { app }
}

export async function runFreshWorkspaceAppsInFilesBrowserAcceptance(args: {
  env: LiveEnv
  page: Page
  workspace: Workspace
  apiToken: string
  runId: string
  initialApp: App
  artifacts: StagingArtifactCollector
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
}): Promise<AppsInFilesAcceptanceEvidence> {
  const { env, page, workspace, apiToken, runId, initialApp, artifacts, ledger, convex } = args
  const desktopScreenshot = path.join(artifacts.directory, 'apps-in-file-view-desktop.png')
  const mobileScreenshot = path.join(artifacts.directory, 'apps-in-file-view-mobile.png')
  const waitForHello = async (
    expectedPath: string,
    expectedState: App['anchorState'],
    expectedRuntimeStatus?: App['runtimeStatus'],
  ) =>
    await waitForHelloAppState({
      expectedId: initialApp.id,
      expectedPath,
      expectedState,
      ...(expectedRuntimeStatus === undefined ? {} : { expectedRuntimeStatus }),
      load: async () =>
        (await loadApp(env, workspace.slug, HELLO_SLUG, bearer(apiToken), artifacts)).app,
    })

  await openWelcomeFolder(page, env, workspace.slug)
  await assertSeededFilesAndRunningApp(page, 'hello-app')
  await assertRenderedAppIcon(page, 'hello-app')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: desktopScreenshot, fullPage: true, animations: 'disabled' })
  const mobile = await page.context().newPage()
  try {
    markExpectedViewportChange(mobile)
    await mobile.setViewportSize({ width: 390, height: 844 })
    await openWelcomeFolder(mobile, env, workspace.slug)
    await assertSeededFilesAndRunningApp(mobile, 'hello-app')
    await assertRenderedAppIcon(mobile, 'hello-app')
    await mobile.mouse.move(0, 0)
    await mobile.screenshot({ path: mobileScreenshot, fullPage: true, animations: 'disabled' })
  } finally {
    markExpectedBrowserTransition(mobile)
    await mobile.close()
  }

  await previewSeedFiles(page, workspace.slug)
  await assertHelloAppOpens(page, env, initialApp, workspace.slug)
  await assertFolderControls(page, env, workspace.slug, 'hello-app')

  const renameStartedAt = Date.now()
  const folderRenamedAt = await renameAppFolder(page, workspace.slug, 'hello-app', 'hello2')
  let anchorLandedAt: number | undefined
  const renamed = await waitForLiveApp({
    env,
    workspaceSlug: workspace.slug,
    apiToken,
    artifacts,
    expectedId: initialApp.id,
    expectedPath: RENAMED_HELLO_PATH,
    onAnchorLanded: at => {
      anchorLandedAt ??= at
    },
  })
  const renameConvergenceMs = Date.now() - renameStartedAt
  /* From the rename landing on the drive, not from the dialog opening. The
     first measurement charged the rail for a menu click, a dialog, a typed name
     and a submit — a person's half of the work, timed as the poll's. Candidates
     come from the previous snapshot's inode (`renameCandidatesFromEarlier`), so
     the rail should pair the folder on its first poll after the change. */
  const anchorAdoptionMs = (anchorLandedAt ?? Date.now()) - folderRenamedAt
  assert(
    anchorAdoptionMs <= ANCHOR_ADOPTION_BUDGET_MS,
    `the anchor rail took ${anchorAdoptionMs}ms to follow the folder once the drive held the new name; ` +
      `one idle poll is ${IDLE_SYNC_CEILING_MS}ms`,
  )
  assert(
    renameConvergenceMs <= APP_RENAME_CONVERGENCE_BUDGET_MS,
    `serving the app from its new folder took ${renameConvergenceMs}ms total, ` +
      `of which the anchor rail was ${anchorAdoptionMs}ms`,
  )
  await openWelcomeFolder(page, env, workspace.slug)
  await assertRunningAppRow(page, 'hello2')
  await assertRenderedAppIcon(page, 'hello2')

  await copyThenDeleteAppFolder({
    env,
    workspace,
    apiToken,
    runId,
    sourcePath: RENAMED_HELLO_PATH,
    destinationPath: UI_REPAIR_HELLO_PATH,
    artifacts,
    ledger,
    convex,
  })
  /* Its anchor survives and its runtime does not, which is what emptying a
     folder under a live app actually does.
     
     `broken` is not reachable this way, and two runs went looking for it. The
     anti-hijack refusal fires only while the gateway still remembers the right
     marker at that path, and the app reconciler heals a marker it finds missing,
     so a folder swapped out between two polls is adopted rather than refused.
     What is left is honest and is the state a person would see: the app is still
     anchored where they left it, and it cannot start because its files are gone.
     `broken` keeps its coverage on `resolveAnchorRenameDecisions`, where the
     refusal can be driven directly instead of staged against a rail that repairs
     itself. */
  await waitForHello(RENAMED_HELLO_PATH, 'broken')

  /* The drive draws a row for the folder that is there, and no app row: the
     listing IS the row set now, where the drive used to synthesize a "phantom"
     row so a permanently stranded app stayed reachable. This app is not
     stranded — something occupies its path that Duet cannot identify, which is
     what keeps the anchor `broken` instead of reaping it — and it is reachable
     the way every app is, at its own address.
     
     This comment used to say the marker turned up at the copy. It does not:
     `copyTree` skips `.duet-anchor` so one anchor never has two claimants, and
     the folder standing at the old path is what makes this `broken` rather than
     gone. Written from reasoning, corrected by a live run. */
  await openWelcomeFolder(page, env, workspace.slug)
  const strandedRow = filesRow(page, 'welcome/hello2')
  await strandedRow.waitFor()
  assert.equal(
    await strandedRow.getAttribute('data-files-card'),
    'document',
    'the drive still calls the old path an app after a file took its place',
  )
  assert.equal(
    await strandedRow.getAttribute('data-app-status'),
    null,
    'a plain file carried an app status',
  )
  /* A broken app lives where every app lives: on the card of the agent whose
     folder encloses it, and an app the drive holds directly is the drive's own
     agent — `root`. It explains itself there and offers no repair. Repairing
     meant typing the folder's new Drive path, a sentence about anchors that is
     the product's own word for something a reader has never had to know; the
     API still does it, which is what the two repairs below prove. */
  await page.goto(`${env.appUrl}/w/${workspace.slug}/agents/${ROOT_AGENT_SCOPE}/apps/${HELLO_SLUG}`)
  await page.getByText('Folder link needs repair').waitFor()
  assert.equal(
    await page.locator('input[name="repairPath"]').count(),
    0,
    'the deleted repair form is still on the app card',
  )
  const repairedFromApi = AppResponseSchema.parse(
    await loadJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/apps/${HELLO_SLUG}/reanchor`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ path: UI_REPAIR_HELLO_PATH }),
      },
      200,
      'hello slug reanchor after the phantom row',
      artifacts,
    ),
  ).app
  assert.equal(repairedFromApi.id, initialApp.id)
  assert.equal(repairedFromApi.anchorPath, UI_REPAIR_HELLO_PATH)
  assert.equal(repairedFromApi.anchorState, 'active')
  await waitForHello(UI_REPAIR_HELLO_PATH, 'active')
  await openWelcomeFolder(page, env, workspace.slug)
  await assertRunningAppRow(page, 'hello-repaired')
  await assertRenderedAppIcon(page, 'hello-repaired')

  await copyThenDeleteAppFolder({
    env,
    workspace,
    apiToken,
    runId,
    sourcePath: UI_REPAIR_HELLO_PATH,
    destinationPath: DIRECT_REPAIR_HELLO_PATH,
    artifacts,
    ledger,
    convex,
  })
  await waitForHello(UI_REPAIR_HELLO_PATH, 'broken')
  const directRepair = AppResponseSchema.parse(
    await loadJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/apps/${HELLO_SLUG}/reanchor`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ path: DIRECT_REPAIR_HELLO_PATH }),
      },
      200,
      'direct hello slug reanchor',
      artifacts,
    ),
  ).app
  assert.equal(directRepair.id, initialApp.id)
  assert.equal(directRepair.anchorPath, DIRECT_REPAIR_HELLO_PATH)
  assert.equal(directRepair.anchorState, 'active')
  await waitForHello(DIRECT_REPAIR_HELLO_PATH, 'active')
  await openWelcomeFolder(page, env, workspace.slug)
  await assertRunningAppRow(page, 'hello-final')
  await assertRenderedAppIcon(page, 'hello-final')

  await deleteAppFolderThroughFiles(page, workspace.slug, 'hello-final')
  // Deleting in Files deletes the FOLDER, and only the folder. The app row
  // follows on its own: the anchor rail reaps a row whose folder stays gone, so
  // this waits for that convergence rather than expecting the two deletions to
  // have happened in one request. The folder itself is gone immediately.
  const missingFolder = await timedFetch(
    `${env.apiUrl}/v1/ws/${workspace.slug}/files/${DIRECT_REPAIR_HELLO_PATH}?stat=1`,
    { headers: bearer(apiToken) },
    artifacts,
  )
  assert.equal(missingFolder.status, 404, 'the Files deletion left the hello folder behind')
  const reapDeadline = Date.now() + APP_REAP_BUDGET_MS
  let appStatus = 0
  do {
    appStatus = (
      await timedFetch(
        `${env.apiUrl}/v1/ws/${workspace.slug}/apps/${HELLO_SLUG}`,
        { headers: bearer(apiToken) },
        artifacts,
      )
    ).status
    if (appStatus === 404) break
    await Bun.sleep(2_000)
  } while (Date.now() < reapDeadline)
  assert.equal(appStatus, 404, 'the app row outlived the folder it was anchored to')

  return {
    appId: renamed.id,
    initialPath: INITIAL_HELLO_PATH,
    renamedPath: RENAMED_HELLO_PATH,
    uiRepairPath: UI_REPAIR_HELLO_PATH,
    directRepairPath: DIRECT_REPAIR_HELLO_PATH,
    renameConvergenceMs,
    anchorAdoptionMs,
    screenshots: {
      desktop: path.basename(desktopScreenshot),
      mobile: path.basename(mobileScreenshot),
    },
  }
}

type FreshWorkspaceSeedSnapshot = {
  rootEntries: readonly FileEntry[]
  welcomeEntries: readonly FileEntry[]
  welcomeApps: readonly App[]
  rootApps: readonly App[]
  directApp: App
}

export function assertFreshWorkspaceSeed(args: FreshWorkspaceSeedSnapshot): App {
  assert(
    args.rootEntries.some(entry => entry.name === 'welcome' && entry.type === 'directory'),
    `fresh workspace root omitted welcome/: ${entrySummary(args.rootEntries).join(', ')}`,
  )
  const entries = new Set(entrySummary(args.welcomeEntries))
  for (const expected of SEEDED_WELCOME_ENTRIES) {
    assert(entries.has(expected), `welcome/ omitted seeded entry ${expected}`)
  }
  assert(
    args.rootApps.every(app => !app.anchorPath.includes('/')),
    `root children query leaked nested apps: ${args.rootApps
      .map(app => `${app.slug}:${app.anchorPath}`)
      .join(', ')}`,
  )
  assert(
    args.rootApps.every(app => app.slug !== HELLO_SLUG),
    'root children query included the nested hello app',
  )
  assert(
    args.welcomeApps.every(
      app => app.anchorPath === 'welcome' || app.anchorPath.startsWith('welcome/'),
    ),
    `welcome subtree query leaked apps: ${args.welcomeApps
      .map(app => `${app.slug}:${app.anchorPath}`)
      .join(', ')}`,
  )
  const listed = args.welcomeApps.find(app => app.slug === HELLO_SLUG)
  assert(listed !== undefined, 'welcome subtree omitted the hello app')
  assert.equal(listed.anchorPath, 'welcome/hello-app')
  assert.equal(listed.anchorState, 'active')
  if (listed.runtimeStatus === 'reconcile_failed') {
    throw new Error(
      `Fresh workspace app reconciliation failed: ${listed.reconciliationError ?? 'unknown gateway error'}`,
    )
  }
  assert.equal(listed.runtimeStatus, 'reconciled')
  assert.equal(args.directApp.id, listed.id, 'direct hello lookup changed app identity')
  assert.equal(args.directApp.slug, listed.slug)
  assert.equal(args.directApp.anchorPath, listed.anchorPath)
  assert.equal(args.directApp.anchorState, listed.anchorState)
  assert.equal(args.directApp.runtimeStatus, listed.runtimeStatus)
  return args.directApp
}

export async function waitForFreshWorkspaceSeed(args: {
  load: () => Promise<FreshWorkspaceSeedSnapshot>
  timeoutMs?: number
  pollMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<App> {
  const timeoutMs = args.timeoutMs ?? 120_000
  const pollMs = args.pollMs ?? 1_000
  const sleep = args.sleep ?? Bun.sleep
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      return assertFreshWorkspaceSeed(await args.load())
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Fresh workspace app reconciliation failed:')
      ) {
        throw error
      }
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the fresh workspace seed: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      )
    }
    await sleep(pollMs)
  }
}

export async function waitForHelloAppState(args: {
  expectedId: string
  expectedPath: string
  expectedState: App['anchorState']
  /* Pins the runtime half as well, for the states where the anchor being fine is
     the point: an app whose folder was emptied under it keeps its anchor and
     loses its runtime, and `active` alone cannot tell that from a healthy app. */
  expectedRuntimeStatus?: App['runtimeStatus']
  load: () => Promise<App>
  timeoutMs?: number
  pollMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  /* Called on the first sample whose anchor has landed, whatever the runtime is
     still doing. Convergence here means two rails finished, not one: the anchor
     rail follows the folder, then the app is served again from where it moved
     to. A single number cannot say which of them was slow, and it billed both
     to the sync tick. */
  onAnchorLanded?: (at: number) => void
}): Promise<App> {
  const timeoutMs = args.timeoutMs ?? 120_000
  const pollMs = args.pollMs ?? 1_000
  const sleep = args.sleep ?? Bun.sleep
  const deadline = Date.now() + timeoutMs
  let last: App | undefined
  for (;;) {
    last = await args.load()
    assert.equal(
      last.id,
      args.expectedId,
      `hello app identity changed from ${args.expectedId} to ${last.id}`,
    )
    if (last.anchorPath === args.expectedPath && last.anchorState === args.expectedState) {
      args.onAnchorLanded?.(Date.now())
    }
    const runtimeSettled =
      args.expectedRuntimeStatus !== undefined
        ? last.runtimeStatus === args.expectedRuntimeStatus
        : args.expectedState !== 'active' || last.runtimeStatus === 'reconciled'
    if (
      last.anchorPath === args.expectedPath &&
      last.anchorState === args.expectedState &&
      runtimeSettled
    ) {
      return last
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for hello app ${args.expectedState} at ${args.expectedPath}; ` +
          `last=${JSON.stringify(appWaitSummary(last))}`,
      )
    }
    await sleep(pollMs)
  }
}

function entrySummary(entries: readonly FileEntry[]): string[] {
  return entries.map(entry => `${entry.name}:${entry.type}`).sort()
}

function appWaitSummary(
  app: App,
): Pick<App, 'id' | 'anchorPath' | 'anchorState' | 'runtimeStatus'> {
  return {
    id: app.id,
    anchorPath: app.anchorPath,
    anchorState: app.anchorState,
    runtimeStatus: app.runtimeStatus,
  }
}

async function loadFileList(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  filePath: string,
  headers: Headers,
  artifacts: StagingArtifactCollector,
) {
  const suffix = filePath.length === 0 ? '' : `/${filePath}`
  return FileListResponseSchema.parse(
    await loadJson(
      `${env.apiUrl}/v1/ws/${workspaceSlug}/files${suffix}?list=1`,
      { headers },
      200,
      `fresh workspace ${filePath || 'root'} files`,
      artifacts,
    ),
  )
}

async function loadApps(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  filter: { path?: string; scope?: 'children' | 'subtree' },
  headers: Headers,
  artifacts: StagingArtifactCollector,
) {
  return AppListResponseSchema.parse(
    await loadJson(
      appsUrl(env.apiUrl, workspaceSlug, filter),
      { headers },
      200,
      'fresh workspace apps list',
      artifacts,
    ),
  )
}

async function loadApp(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  appSlug: string,
  headers: Headers,
  artifacts: StagingArtifactCollector,
) {
  return AppResponseSchema.parse(
    await loadJson(
      `${env.apiUrl}/v1/ws/${workspaceSlug}/apps/${appSlug}`,
      { headers },
      200,
      `${appSlug} app lookup`,
      artifacts,
    ),
  )
}

function appsUrl(
  apiUrl: string,
  workspaceSlug: string,
  filter: { path?: string; scope?: 'children' | 'subtree' },
): string {
  const url = new URL(`${apiUrl}/v1/ws/${workspaceSlug}/apps`)
  if (filter.path !== undefined) url.searchParams.set('path', filter.path)
  if (filter.scope !== undefined) url.searchParams.set('scope', filter.scope)
  return url.toString()
}

async function loadJson(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  label: string,
  artifacts: StagingArtifactCollector,
): Promise<unknown> {
  const response = await timedFetch(url, init, artifacts)
  assert.equal(
    response.status,
    expectedStatus,
    `${label} expected HTTP ${expectedStatus}, got ${response.status}`,
  )
  return await response.json()
}

async function openWelcomeFolder(page: Page, env: LiveEnv, workspaceSlug: string): Promise<void> {
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspaceSlug}/files`)
  // The files surface's structural marker is the contract; the accessible
  // name is product copy ("Drive" in every locale today) and an instant
  // count() races hydration, so just wait for the marker.
  await page.locator('[data-files-surface]').waitFor()
  await clickRowAction(filesRow(page, 'welcome'), 'menu', /^(Actions for|Acciones para) welcome$/)
  await clickMenuAction(page, 'open-folder', /^(Open|Abrir)$/)
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: 'welcome', exact: true })
    .waitFor()
}

async function assertSeededFilesAndRunningApp(page: Page, appFolderName: string): Promise<void> {
  for (const name of ['README.md', 'sample.pdf', 'deck.pptx', 'clip.mp4']) {
    await filesRow(page, `welcome/${name}`).waitFor()
  }
  await assertRunningAppRow(page, appFolderName)
}

async function assertRunningAppRow(page: Page, folderName: string): Promise<void> {
  const row = filesRow(page, `welcome/${folderName}`)
  await row.waitFor()
  assert.equal(await row.getAttribute('data-files-card'), 'app')
  assert.equal(await row.getAttribute('data-app-status'), 'reconciled')
}

async function assertRenderedAppIcon(page: Page, folderName: string): Promise<void> {
  const icon = filesRow(page, `welcome/${folderName}`).locator('img')
  await icon.waitFor()
  const naturalWidth = await icon.evaluate(async (image: HTMLImageElement) => {
    await image.decode()
    return image.naturalWidth
  })
  assert.ok(naturalWidth > 0, `app icon for ${folderName} decoded without pixels`)
}

async function previewSeedFiles(page: Page, workspaceSlug: string): Promise<void> {
  await previewSeedFile(page, workspaceSlug, 'README.md', async () => {
    await page
      .getByRole('heading', { name: 'Welcome to your Duet workspace', exact: true })
      .waitFor()
  })
  await previewSeedFile(page, workspaceSlug, 'sample.pdf', async () => {
    await page.locator('iframe[title="sample.pdf"]').waitFor()
  })
  await previewSeedFile(page, workspaceSlug, 'deck.pptx', async () => {
    const canvas = page.locator(
      '[data-files-preview] canvas, section[aria-label="Preview"] canvas, section[aria-label="Vista previa"] canvas',
    )
    await canvas.waitFor()
    await page.waitForFunction(() => {
      const candidate = document.querySelector<HTMLCanvasElement>(
        '[data-files-preview] canvas, section[aria-label="Preview"] canvas, section[aria-label="Vista previa"] canvas',
      )
      const context = candidate?.getContext('2d')
      if (candidate === null || context == null) return false
      const pixels = context.getImageData(0, 0, candidate.width, candidate.height).data
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index + 3] !== 0 &&
          (pixels[index] !== 255 || pixels[index + 1] !== 255 || pixels[index + 2] !== 255)
        ) {
          return true
        }
      }
      return false
    })
  })
  await previewSeedFile(page, workspaceSlug, 'clip.mp4', async () => {
    const video = page.locator(
      '[data-files-preview] video, section[aria-label="Preview"] video, section[aria-label="Vista previa"] video',
    )
    /* Either outcome proves the same thing, and which one arrives is the
       browser's business rather than Duet's. `clip.mp4` is H.264, and the
       Chromium Playwright bundles carries no proprietary codecs — the repo's own
       hermetic media tests use VP8 WebM for exactly that reason. So this browser
       cannot decode the seed, the viewer says so, and offers the file instead.
       Demanding a playing video here demanded a codec the runner does not have,
       and the strict checks below made it worse by requiring `error` to be
       unset when this browser must set it.

       What still has to hold is that the mp4 reached the video viewer at all:
       `Playback unavailable` is the video branch's own copy, so seeing it rules
       out a file the surface failed to recognize as media, and the two actions
       are what make the fallback worth having. Where the browser can decode,
       the original assertions run untouched. */
    const unavailable = page.getByText('Playback unavailable', { exact: true })
    await video.or(unavailable).first().waitFor()
    if ((await video.count()) === 0) {
      await unavailable.waitFor()
      await page.getByRole('link', { name: 'Open in new tab', exact: true }).first().waitFor()
      await page.getByRole('link', { name: 'Download', exact: true }).first().waitFor()
      return
    }
    const state = await video.evaluate((candidate: HTMLVideoElement) => {
      return {
        currentSrc: candidate.currentSrc,
        errorCode: candidate.error?.code ?? null,
        networkState: candidate.networkState,
      }
    })
    assertVideoPreviewState({
      ...state,
      expectedPath: `/api/duet/ws/${workspaceSlug}/files/welcome/clip.mp4`,
    })
  })
}

export function assertVideoPreviewState(args: {
  currentSrc: string
  errorCode: number | null
  networkState: number
  expectedPath: string
}): void {
  assert.equal(new URL(args.currentSrc).pathname, args.expectedPath)
  assert.equal(args.errorCode, null, 'video preview reported a media error')
  assert.notEqual(args.networkState, 3, 'video preview had no usable media source')
}

async function previewSeedFile(
  page: Page,
  workspaceSlug: string,
  name: string,
  assertRendered: () => Promise<void>,
): Promise<void> {
  const response = waitForFinishedBrowserResponse(
    page,
    'GET',
    `/api/duet/ws/${workspaceSlug}/files/welcome/${name}`,
  )
  await filesRow(page, `welcome/${name}`).click()
  await response
  // Both the preview title and the card can expose the filename as a heading;
  // the first visible match is the preview chrome.
  await page.getByRole('heading', { name, exact: true }).first().waitFor()
  await assertRendered()
  // The preview is a modal dialog whose backdrop swallows clicks — dismiss it
  // before the caller reaches for the next card.
  await page.keyboard.press('Escape')
  await page
    .locator('div[data-aria-hidden="true"][data-state="open"]')
    .first()
    .waitFor({ state: 'detached' })
    .catch(() => undefined)
}

// The seeded app is private, so its public URL refuses everyone. Clicking it in
// Files must land on the card of the agent that owns it — nothing encloses this
// one, so it is the drive's own agent — and serve the app there.
async function assertHelloAppOpens(
  page: Page,
  env: LiveEnv,
  app: App,
  workspaceSlug: string,
): Promise<void> {
  markExpectedBrowserTransition(page)
  await filesRow(page, INITIAL_HELLO_PATH).click()
  await page.waitForURL(
    url => url.pathname === `/w/${workspaceSlug}/agents/${ROOT_AGENT_SCOPE}/apps/${app.slug}`,
  )
  /* The sample app's own panel, not a heading. `513bb5bb` rewrote that page and
     the word `Tasks` survives only as the task list's label, so the heading this
     waited for stopped existing — the app was serving correctly the whole
     minute. The panel is the app's working half rather than its prose, so it
     answers the same question and outlives the next copy edit. */
  await page
    .frameLocator(`iframe[title="${app.name ?? 'hello-app'}"]`)
    .getByRole('region', { name: 'Task list', exact: true })
    .waitFor()
  // The caller keeps browsing the welcome folder it was in.
  await openWelcomeFolder(page, env, workspaceSlug)
}

async function assertFolderControls(
  page: Page,
  env: LiveEnv,
  workspaceSlug: string,
  folderName: string,
): Promise<void> {
  /* One way in, because the drive has one. This used to open the folder twice —
     once by a caret button on the row, once by the row's menu — and the caret
     belongs to `DriveBrowser`, which is now only what the publish viewer
     renders. The workspace drive is `DriveColumnsBrowser`, whose row carries a
     single button that opens the app, so an app's folder is reachable from the
     menu and nowhere else. Both layouts publish the same
     `data-files-card`/`data-app-status` vocabulary, which is why the assertions
     above could not tell that this one had moved. */
  await clickRowAction(
    filesRow(page, `welcome/${folderName}`),
    'menu',
    new RegExp(`^(Actions for|Acciones para) ${folderName}$`),
  )
  await clickMenuAction(page, 'open-folder', /^(Open folder|Abrir carpeta)$/)
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: folderName, exact: true })
    .waitFor()
  await openWelcomeFolder(page, env, workspaceSlug)
}

/** Returns the moment the drive actually held the new name, which is when the
 *  anchor rail's clock starts. Everything before it is a person operating a
 *  dialog. */
async function renameAppFolder(
  page: Page,
  workspaceSlug: string,
  fromName: string,
  toName: string,
): Promise<number> {
  await clickRowAction(
    filesRow(page, `welcome/${fromName}`),
    'menu',
    new RegExp(`^(Actions for|Acciones para) ${fromName}$`),
  )
  await clickMenuAction(page, 'rename', /^(Rename|Renombrar)$/)
  const dialog = page.getByRole('dialog')
  await dialog.locator('input').fill(toName)
  const response = waitForFinishedBrowserResponse(
    page,
    'POST',
    `/api/duet/ws/${workspaceSlug}/files/actions`,
  )
  await dialog.locator('[data-files-dialog-action="confirm"]').click()
  FileOperationResponseSchema.parse(await (await response).json())
  const renamedAt = Date.now()
  await filesRow(page, `welcome/${toName}`).waitFor()
  return renamedAt
}

async function waitForLiveApp(args: {
  env: LiveEnv
  workspaceSlug: string
  apiToken: string
  artifacts: StagingArtifactCollector
  expectedId: string
  expectedPath: string
  onAnchorLanded?: (at: number) => void
}): Promise<App> {
  return await waitForHelloAppState({
    expectedId: args.expectedId,
    expectedPath: args.expectedPath,
    expectedState: 'active',
    ...(args.onAnchorLanded === undefined ? {} : { onAnchorLanded: args.onAnchorLanded }),
    load: async () =>
      (
        await loadApp(
          args.env,
          args.workspaceSlug,
          HELLO_SLUG,
          bearer(args.apiToken),
          args.artifacts,
        )
      ).app,
  })
}

async function copyThenDeleteAppFolder(args: {
  env: LiveEnv
  workspace: Workspace
  apiToken: string
  runId: string
  sourcePath: string
  destinationPath: string
  artifacts: StagingArtifactCollector
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
}): Promise<void> {
  await operateFiles(
    args,
    {
      operation: 'copy',
      source: args.sourcePath,
      destination: args.destinationPath,
      recursive: true,
      overwrite: false,
    },
    'copy hello folder before break',
  )
  args.ledger.record({
    kind: 'file',
    id: args.destinationPath,
    label: `${args.runId}:file:${args.destinationPath}`,
    cleanup: async () => {
      const response = await stagingFetch(
        `${args.env.apiUrl}/v1/ws/${args.workspace.slug}/files/actions`,
        {
          method: 'POST',
          headers: bearerJson(args.apiToken),
          body: JSON.stringify({
            operation: 'delete',
            path: args.destinationPath,
            recursive: true,
          }),
        },
      )
      assert(
        response.status === 200 || response.status === 404,
        `hello folder cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.workspace._id),
  })
  await operateFiles(
    args,
    {
      operation: 'delete',
      path: args.sourcePath,
      recursive: true,
    },
    'delete the original hello folder',
  )
  /* A FILE where the folder was, which is the one substitution the rail cannot
     talk itself out of.
     
     The repairs below need `broken`, because `reanchor` refuses an anchor that is
     not — and getting there took three runs of being wrong. Copy-then-delete
     alone is `traceless`, so the row is reaped and there is nothing left to
     repair. An empty FOLDER back at the path is adopted instead of refused: the
     app reconciler heals a marker it finds missing, and both edits land between
     two thirty-second polls, so the gateway only ever sees a folder wearing the
     right marker.
     
     A file cannot be healed into a directory anchor. The first thing
     `prepareCurrentAnchorSnapshot` checks is the kind, and a directory anchor
     that finds a file at its path is refused outright — no marker consulted, no
     nonce vouching for it. That is `broken`, on purpose and on the first poll
     that sees it. */
  await apiText(
    `${args.env.apiUrl}/v1/ws/${args.workspace.slug}/files/${args.sourcePath}`,
    {
      method: 'PUT',
      headers: bearer(args.apiToken, { 'content-type': 'text/plain' }),
      body: 'The folder this app was anchored to is a file now.\n',
    },
    200,
    'replace the hello folder with a file',
    args.artifacts,
  )
}

async function operateFiles(
  args: {
    env: LiveEnv
    workspace: Workspace
    apiToken: string
    artifacts: StagingArtifactCollector
  },
  operation: FileOperationRequest,
  label: string,
): Promise<void> {
  FileOperationResponseSchema.parse(
    await loadJson(
      `${args.env.apiUrl}/v1/ws/${args.workspace.slug}/files/actions`,
      {
        method: 'POST',
        headers: bearerJson(args.apiToken),
        body: JSON.stringify(operation),
      },
      200,
      label,
      args.artifacts,
    ),
  )
}

async function deleteAppFolderThroughFiles(
  page: Page,
  workspaceSlug: string,
  folderName: string,
): Promise<void> {
  await clickRowAction(
    filesRow(page, `welcome/${folderName}`),
    'menu',
    new RegExp(`^(Actions for|Acciones para) ${folderName}$`),
  )
  await clickMenuAction(page, 'delete', /^(Delete|Eliminar)$/)
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  assert((await dialog.textContent())?.includes(HELLO_SLUG), 'app delete dialog omitted app slug')
  assert(
    (await dialog.textContent())?.includes(folderName),
    'app delete dialog omitted folder name',
  )
  /* One request, because deleting in Files deletes the folder and nothing else.
     This waited for a `DELETE /apps/:slug` alongside it and spent a minute on an
     event that no longer happens: the row is not deleted by the click, it is
     reaped once the drive keeps saying the folder is gone. The dialog says so —
     it names the app as well as the folder — and the loop at the end of this leg
     is what proves the row actually goes. */
  const folderDelete = waitForFinishedBrowserResponse(
    page,
    'POST',
    `/api/duet/ws/${workspaceSlug}/files/actions`,
  )
  await dialog.locator('[data-files-dialog-action="confirm"]').click()
  FileOperationResponseSchema.parse(await (await folderDelete).json())
  await filesRow(page, `welcome/${folderName}`).waitFor({
    state: 'detached',
  })
}

function filesRow(page: Page, drivePath: string) {
  return page.locator(`[data-files-row-key="/${drivePath}"]`)
}

async function clickRowAction(
  row: ReturnType<Page['locator']>,
  action: 'open-folder' | 'menu',
  fallbackName: RegExp,
): Promise<void> {
  // The row first: `count()` does not wait, so asking before the listing paints
  // reads zero and quietly downgrades to matching product copy, which then
  // spends the whole timeout being the wrong reason for the failure.
  await row.waitFor()
  const structural = row.locator(`[data-files-action="${action}"]`)
  if ((await structural.count()) > 0) {
    await structural.click()
    return
  }
  await row.getByRole('button', { name: fallbackName }).click()
}

async function clickMenuAction(
  page: Page,
  action: 'open-folder' | 'rename' | 'delete',
  fallbackName: RegExp,
): Promise<void> {
  const structural = page.locator(`[data-files-menu-action="${action}"]`)
  if ((await structural.count()) > 0) {
    await structural.click()
    return
  }
  await page.getByRole('menuitem', { name: fallbackName }).click()
}
