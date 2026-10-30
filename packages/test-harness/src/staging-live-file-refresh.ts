import assert from 'node:assert/strict'

import type { Locator, Page } from '@playwright/test'

import {
  FileDeleteResponseSchema,
  FileStatResponseSchema,
  FileWriteResponseSchema,
} from '@repo/contract'

import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { apiJson, apiText, bearer, stagingFetch } from './staging-live-http.ts'
import { StagingResourceLedger, workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const LIVE_WAIT_MS = 45_000
const CONDITION_POLL_MS = 250

const LIVE_FILE_REFRESH_TRANSITIONS = [
  'live',
  'updated',
  'autosaved',
  'conflict',
  'reloaded',
  'churned',
  'replaced',
  'reconnecting',
  'missing',
  'recovered',
  'reconnecting',
  'missing',
  'back-to-folder',
] as const

type LiveFileRefreshTransition = (typeof LIVE_FILE_REFRESH_TRANSITIONS)[number]

export interface LiveFileRefreshEvidence {
  filePath: string
  addressedPathname: string
  transitions: LiveFileRefreshTransition[]
  initialEtag: string
  replacementEtag: string
  recoveryEtag: string
  paneStable: boolean
  editorStable: boolean
  skeletonInsertions: number
  replacementRemoteContent: string
  recoveryContent: string
}

export interface LiveFileRefreshFixture {
  fileName: string
  path: string
  contents: {
    initial: string
    remoteUpdate: string
    localDraft: string
    remoteConflict: string
    replacement: string
    recovery: string
  }
}

export function createLiveFileRefreshFixture(runId: string): LiveFileRefreshFixture {
  const suffix = runId
    .slice(-10)
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
  const fileName = `live-refresh-${suffix}.txt`
  const content = (stage: string) => `${stage}:${runId}\n`
  return {
    fileName,
    path: fileName,
    contents: {
      initial: content('initial'),
      remoteUpdate: content('remote-update'),
      localDraft: content('local-draft'),
      remoteConflict: content('remote-conflict'),
      replacement: content('browser-replacement'),
      recovery: content('same-path-recovery'),
    },
  }
}

export function liveFileRefreshPathname(workspaceSlug: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `/w/${encodeURIComponent(workspaceSlug)}/files/${encodedPath}`
}

export function recordLiveFileRefreshCleanup(args: {
  ledger: StagingResourceLedger
  path: string
  cleanup: () => Promise<unknown>
  verify: () => Promise<boolean>
}): void {
  args.ledger.record({
    kind: 'file',
    id: args.path,
    label: `${args.ledger.runId}:live-file-refresh-file:${args.path}`,
    cleanup: args.cleanup,
    verify: args.verify,
  })
}

export async function runLiveFileRefreshJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<LiveFileRefreshEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'live-file-refresh',
    label: 'Live File Refresh',
    onProgress: options.onProgress,
    run: runLiveFileRefreshAcceptance,
  })
}

export async function runLiveFileRefreshAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<LiveFileRefreshEvidence> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const fixture = createLiveFileRefreshFixture(runId)
  const encodedPath = fixture.path.split('/').map(encodeURIComponent).join('/')
  const fileUrl = `${env.apiUrl}/v1/ws/${workspace.slug}/files/${encodedPath}`
  const transitions: LiveFileRefreshTransition[] = []

  const writeFile = async (content: string, label: string) =>
    FileWriteResponseSchema.parse(
      await apiJson(
        fileUrl,
        {
          method: 'PUT',
          headers: bearer(apiToken, { 'content-type': 'text/plain; charset=utf-8' }),
          body: content,
        },
        200,
        label,
        artifacts,
      ),
    )

  const deleteFile = async (label: string) => {
    FileDeleteResponseSchema.parse(
      await apiJson(
        fileUrl,
        { method: 'DELETE', headers: bearer(apiToken) },
        200,
        label,
        artifacts,
      ),
    )
  }

  progress('live-file-refresh:create')
  const initialWrite = await writeFile(fixture.contents.initial, 'live refresh initial file write')
  recordLiveFileRefreshCleanup({
    ledger,
    path: fixture.path,
    cleanup: async () => {
      const response = await stagingFetch(fileUrl, {
        method: 'DELETE',
        headers: bearer(apiToken),
      })
      assert(
        [200, 404].includes(response.status),
        `live refresh file cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })

  progress('live-file-refresh:open-once')
  const addressedPathname = liveFileRefreshPathname(workspace.slug, fixture.path)
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}${addressedPathname}`)
  await page.waitForURL(url => url.pathname === addressedPathname, { timeout: LIVE_WAIT_MS })

  const pane = page.locator('[data-files-preview-pane]')
  const editor = pane.locator('[data-files-editor]')
  const backToFolder = pane.locator('[data-files-live-action="back-to-folder"]')
  await pane.waitFor({ timeout: LIVE_WAIT_MS })
  await editor.waitFor({ timeout: LIVE_WAIT_MS })
  await waitForEditorValue(page, fixture.contents.initial)
  await waitForLiveDocument(page)
  transitions.push('live')

  const paneHandle = await pane.elementHandle()
  const editorHandle = await editor.elementHandle()
  assert(paneHandle !== null, 'live refresh preview pane had no element handle')
  assert(editorHandle !== null, 'live refresh editor had no element handle')
  const observerKey = `__duet_live_refresh_${runId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`
  await installSkeletonObserver(page, observerKey)

  progress('live-file-refresh:external-update')
  await writeFile(fixture.contents.remoteUpdate, 'live refresh external update')
  await waitForEditorValue(page, fixture.contents.remoteUpdate)
  await waitForLiveDocument(page)
  transitions.push('updated')

  /* Typing settles and the drive holds it, with no control pressed. The proof
     is the file's own bytes, read back over the API. */
  progress('live-file-refresh:autosave')
  await editor.fill(fixture.contents.localDraft)
  await waitForSaveStatus(page, 'saved')
  await waitForRemoteContent(fileUrl, apiToken, fixture.contents.localDraft, artifacts)
  transitions.push('autosaved')

  progress('live-file-refresh:dirty-conflict')
  const conflict = pane.locator('[data-files-live-conflict]')
  await editor.fill(fixture.contents.replacement)
  await keepDraftUnsaved(page, editor, async () => {
    await writeFile(fixture.contents.remoteConflict, 'live refresh conflict update')
    await conflict.waitFor({ timeout: LIVE_WAIT_MS })
  })
  assert.equal(
    await editor.inputValue(),
    fixture.contents.replacement,
    'dirty draft was overwritten',
  )
  await waitForLiveDocument(page)
  transitions.push('conflict')

  progress('live-file-refresh:reload-latest')
  await pane.locator('[data-files-live-action="reload-latest"]').click()
  await waitForEditorValue(page, fixture.contents.remoteConflict)
  await conflict.waitFor({ state: 'hidden', timeout: LIVE_WAIT_MS })
  transitions.push('reloaded')

  /* Same bytes, a new identity. The drive rewrites a file's inode and ctime
     whenever anything touches it, so re-writing the very content already on
     screen must read as churn, not as somebody else's edit. */
  progress('live-file-refresh:identity-churn')
  await editor.fill(fixture.contents.localDraft)
  const churnWrite = await keepDraftUnsaved(page, editor, async () => {
    const written = await writeFile(fixture.contents.remoteConflict, 'live refresh churn rewrite')
    assert.notEqual(written.etag, initialWrite.etag, 'churn rewrite reused the old ETag')
    await waitForRemoteEtag(fileUrl, apiToken, written.etag, artifacts)
    // Long enough for the poll to have seen it and, if it were wrong about
    // what a conflict is, to have said so.
    await page.waitForTimeout(3_000)
    return written
  })
  assert.equal(await conflict.count(), 0, 'identical bytes under a new ETag raised a conflict')
  assert.equal(await editor.inputValue(), fixture.contents.localDraft, 'churn discarded the draft')
  /* Then the words land. The write that follows is conditional on the identity
     the churn minted, which the draft can only be holding if it adopted the
     churn instead of treating it as somebody else's edit. */
  await waitForSaveStatus(page, 'saved')
  await waitForRemoteContent(fileUrl, apiToken, fixture.contents.localDraft, artifacts)
  assert.notEqual(churnWrite.etag, null, 'churn rewrite returned no ETag')
  transitions.push('churned')

  progress('live-file-refresh:replace-file')
  await editor.fill(fixture.contents.replacement)
  await keepDraftUnsaved(page, editor, async () => {
    await writeFile(fixture.contents.remoteUpdate, 'live refresh second conflict update')
    await conflict.waitFor({ timeout: LIVE_WAIT_MS })
  })
  assert.equal(
    await editor.inputValue(),
    fixture.contents.replacement,
    'replacement draft was overwritten',
  )
  // Unsaved *and* unanswerable by autosave: the reader's decision is pending.
  await waitForSaveStatus(page, 'conflict')
  await pane.locator('[data-files-live-action="replace-file"]').click()
  await conflict.waitFor({ state: 'hidden', timeout: LIVE_WAIT_MS })
  await waitForLiveDocument(page)
  await waitForRemoteContent(fileUrl, apiToken, fixture.contents.replacement, artifacts)
  const replacementStat = await writeIdentity(fileUrl, apiToken, artifacts)
  assert.notEqual(replacementStat, initialWrite.etag, 'replacement did not advance the file ETag')
  transitions.push('replaced')

  progress('live-file-refresh:first-delete')
  await deleteFile('live refresh first delete')
  await backToFolder.waitFor({ timeout: LIVE_WAIT_MS })
  assert.equal(
    await editor.inputValue(),
    fixture.contents.replacement,
    'delete cleared last-good text',
  )
  /* No rendered/source toggle to check here: this journey's file is plain
     text, and that pair belongs to Markdown. What a deleted file must show is
     asserted directly — a read-only editor holding the last good bytes, and
     the one way out. */
  transitions.push('reconnecting')
  assert.notEqual(await editor.getAttribute('readonly'), null)
  transitions.push('missing')

  progress('live-file-refresh:same-path-recovery')
  const recoveryWrite = await writeFile(
    fixture.contents.recovery,
    'live refresh same-path recovery',
  )
  assert.notEqual(recoveryWrite.etag, replacementStat, 'same-path recovery reused the old ETag')
  await waitForLiveDocument(page)
  await waitForEditorValue(page, fixture.contents.recovery)
  transitions.push('recovered')

  progress('live-file-refresh:second-delete')
  await deleteFile('live refresh second delete')
  await backToFolder.waitFor({ timeout: LIVE_WAIT_MS })
  transitions.push('reconnecting')
  transitions.push('missing')

  const paneStable = await paneHandle.evaluate(element => element.isConnected)
  const editorStable = await editorHandle.evaluate(element => element.isConnected)
  const skeletonInsertions = await readAndStopSkeletonObserver(page, observerKey)
  assert.equal(paneStable, true, 'warm live refresh remounted the preview pane')
  assert.equal(editorStable, true, 'warm live refresh remounted the editor')
  assert.equal(skeletonInsertions, 0, 'warm live refresh inserted a cold preview skeleton')

  progress('live-file-refresh:back-to-folder')
  await pane.locator('[data-files-live-action="back-to-folder"]').click()
  await pane.waitFor({ state: 'hidden', timeout: LIVE_WAIT_MS })
  await page.waitForFunction(
    () => document.querySelector('[data-files-surface]')?.getAttribute('data-files-path') === '/',
    undefined,
    { timeout: LIVE_WAIT_MS },
  )
  transitions.push('back-to-folder')
  assert.deepEqual(transitions, LIVE_FILE_REFRESH_TRANSITIONS)

  return {
    filePath: fixture.path,
    addressedPathname,
    transitions,
    initialEtag: initialWrite.etag,
    replacementEtag: replacementStat,
    recoveryEtag: recoveryWrite.etag,
    paneStable,
    editorStable,
    skeletonInsertions,
    replacementRemoteContent: fixture.contents.replacement,
    recoveryContent: fixture.contents.recovery,
  }
}

/**
 * The document is showing content, not a skeleton.
 *
 * The connection pill this journey used to read was removed from the header —
 * it was chatter, and the size beside the filename is the more useful fact. So
 * a live refresh is held to what it actually does. The one live state with its
 * own surface is `missing`, asserted directly where that matters.
 */
async function waitForLiveDocument(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-files-preview-pane]') !== null &&
      document.querySelector('[data-files-preview-skeleton]') === null,
    undefined,
    { timeout: LIVE_WAIT_MS },
  )
}

/** The autosave report in the document header. */
async function waitForSaveStatus(
  page: Page,
  status: 'saved' | 'unsaved' | 'saving' | 'conflict',
): Promise<void> {
  try {
    await page.waitForFunction(
      expected => document.querySelector(`[data-files-save-status="${expected}"]`) !== null,
      status,
      { timeout: LIVE_WAIT_MS },
    )
  } catch (error) {
    // A bare "waitForFunction timed out" says nothing about which of these
    // waits gave up, or what the editor was actually reporting instead.
    const seen = await page
      .locator('[data-files-save-status]')
      .first()
      .getAttribute('data-files-save-status')
      .catch(() => null)
    throw new Error(`save status never reached ${status}; editor reported ${seen ?? 'nothing'}`, {
      cause: error,
    })
  }
}

/**
 * Keep a draft unsaved for as long as `while` runs.
 *
 * Autosave waits for the typing to settle, so typing that never settles is the
 * honest way to hold a draft open while the workspace changes the file
 * underneath it. The alternative — parking the write with `page.route` — puts
 * Playwright between the browser and the deployment, and the replayed request
 * loses the protection bypass and is answered by Vercel's SSO instead of the
 * drive.
 */
async function keepDraftUnsaved<T>(
  page: Page,
  editor: Locator,
  during: () => Promise<T>,
): Promise<T> {
  let typing = true
  const keystrokes = (async () => {
    while (typing) {
      // A space and its undo: the text is what it was on every cycle, and the
      // debounce never reaches the end of its wait.
      await editor.press('Space').catch(() => undefined)
      await editor.press('Backspace').catch(() => undefined)
      await page.waitForTimeout(150)
    }
  })()
  try {
    return await during()
  } finally {
    typing = false
    await keystrokes
  }
}

async function waitForEditorValue(page: Page, value: string): Promise<void> {
  await page.waitForFunction(
    expected =>
      (document.querySelector('[data-files-editor]') as HTMLTextAreaElement | null)?.value ===
      expected,
    value,
    { timeout: LIVE_WAIT_MS },
  )
}

async function waitForRemoteContent(
  url: string,
  apiToken: string,
  expected: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<void> {
  await waitForCondition('remote replacement bytes', async () => {
    const value = await apiText(
      url,
      { headers: bearer(apiToken) },
      200,
      'live refresh replacement read',
      artifacts,
    )
    return value === expected
  })
}

/**
 * The drive is serving a given identity. Waited on before asserting that the
 * browser did *not* react to it: without this the assertion could pass simply
 * because the change had not been polled yet.
 */
async function waitForRemoteEtag(
  url: string,
  apiToken: string,
  expected: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<void> {
  await waitForCondition(
    'remote identity',
    async () => (await writeIdentity(url, apiToken, artifacts)) === expected,
  )
}

async function writeIdentity(
  url: string,
  apiToken: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<string> {
  const stat = FileStatResponseSchema.parse(
    await apiJson(
      `${url}?stat=1`,
      { headers: bearer(apiToken) },
      200,
      'live refresh replacement stat',
      artifacts,
    ),
  )
  assert(stat.etag !== null, 'replacement stat returned no ETag')
  return stat.etag
}

async function waitForCondition(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + LIVE_WAIT_MS
  let lastError: unknown
  for (;;) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${label}${lastError === undefined ? '' : `: ${String(lastError)}`}`,
      )
    }
    await Bun.sleep(CONDITION_POLL_MS)
  }
}

async function installSkeletonObserver(page: Page, key: string): Promise<void> {
  await page.evaluate(observerKey => {
    let count = 0
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (
            node.matches('[data-files-preview-skeleton]') ||
            node.querySelector('[data-files-preview-skeleton]') !== null
          ) {
            count += 1
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    ;(globalThis as unknown as Record<string, unknown>)[observerKey] = {
      observer,
      count: () => count,
    }
  }, key)
}

async function readAndStopSkeletonObserver(page: Page, key: string): Promise<number> {
  return await page.evaluate(observerKey => {
    const record = (globalThis as unknown as Record<string, unknown>)[observerKey] as
      | { observer: MutationObserver; count: () => number }
      | undefined
    if (record === undefined) return -1
    record.observer.disconnect()
    const count = record.count()
    delete (globalThis as unknown as Record<string, unknown>)[observerKey]
    return count
  }, key)
}
