import assert from 'node:assert/strict'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  appForCwd,
  FileListResponseSchema,
  isKnownTimelineEvent,
  SessionCreateResponseSchema,
  SessionCwdErrorSchema,
  SessionInputResponseSchema,
  type App,
  type FileEntry,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  deleteStagingSession,
  loadSessionSnapshot,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { verifyFreshWorkspaceAppsAndFilesApi } from './staging-live-apps-files.ts'
import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import {
  markExpectedBrowserTransition,
  markExpectedViewportChange,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import type { LiveEnv } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, timedFetch } from './staging-live-http.ts'
import type { ChronologicalSessionHistory } from './staging-live-pagination.ts'
import { loadChronologicalSessionHistory } from './staging-live-pagination.ts'
import { workspaceIsDeleted, type StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

// 480s: staging exe VMs currently run at ~37% nominal CPU (2026-07-30 upstream
// root-cause), and a fresh runner spawn plus a model turn can exceed 240s.
const SESSION_WAIT_MS = 480_000

export interface SessionAppPaneEvidence {
  sessionId: string
  mutationSessionId: string
  appSlug: string
  appAnchorPath: string
  cwdBefore: string
  cwdAfter: string
  garbageStatus: 422
  cwdAfterGarbage: string
  terminalMarker: string
  agentTaskMarker: string
  timedTaskMarker: string
  domLatencyMs: number
  domLatencyClock: 'response-201'
  paneUrlBefore: string
  paneUrlAfter: string
  sourceUnchanged: boolean
  narrated: boolean
  screenshotPaths: [string, string]
}

interface CwdResponse {
  status: number
  body: unknown
}

export function buildSessionAppPaneMovePrompt(args: { appName: string; marker: string }): string {
  return [
    `This is the session app pane acceptance for the app named "${args.appName}".`,
    'Follow the generated "your apps" guidance in your system prompt.',
    'Use only the move procedure documented there to move this session into that app directory.',
    `When the move succeeds, reply exactly "${args.marker}" and do not do anything else.`,
  ].join(' ')
}

export function buildSessionAppPaneMutationPrompt(marker: string): string {
  return `Add a task named "${marker}" to Hello.`
}

export function inspectSessionAppMutationHistory(
  history: ChronologicalSessionHistory,
  expected: { readmePathSuffix: string; loopbackUrl: string; marker: string },
): {
  readReadme: boolean
  calledLoopbackApi: boolean
  readBeforeCall: boolean
  narrated: boolean
} {
  let readmeReadSeq: number | undefined
  let loopbackCallSeq: number | undefined
  let orderedLoopbackCallSeq: number | undefined

  for (const row of history.events) {
    if (!isKnownTimelineEvent(row.event)) continue
    if (row.event.type !== 'step' || row.event.step.type !== 'tool_call') continue
    if (row.event.step.isError) continue
    const input = JSON.stringify(row.event.step.input ?? {})
    if (input.includes(expected.readmePathSuffix)) readmeReadSeq ??= row.seq
    const postsData =
      input.toUpperCase().includes('POST') ||
      /(?:^|[\s"'\\])(?:-d|--data(?:-[a-z]+)?|--json)(?:[\s"'\\=]|$)/i.test(input)
    if (input.includes(expected.loopbackUrl) && input.includes(expected.marker) && postsData) {
      loopbackCallSeq ??= row.seq
      if (readmeReadSeq !== undefined && readmeReadSeq < row.seq) {
        orderedLoopbackCallSeq ??= row.seq
      }
    }
  }

  const narrated =
    orderedLoopbackCallSeq !== undefined &&
    history.events.some(row => {
      if (row.seq <= orderedLoopbackCallSeq) return false
      if (!isKnownTimelineEvent(row.event)) return false
      if (row.event.type === 'step' && row.event.step.type === 'text') {
        return row.event.step.text.trim().length > 0
      }
      return row.event.type === 'complete' && (row.event.result?.trim().length ?? 0) > 0
    })

  return {
    readReadme: readmeReadSeq !== undefined,
    calledLoopbackApi: loopbackCallSeq !== undefined,
    readBeforeCall: orderedLoopbackCallSeq !== undefined,
    narrated,
  }
}

export async function captureAppSourceSnapshot(
  entries: readonly FileEntry[],
  readFile: (path: string) => Promise<Uint8Array>,
  listDirectory: (path: string) => Promise<readonly FileEntry[]>,
  excludedPaths: ReadonlySet<string>,
): Promise<Array<{ path: string; digest: string }>> {
  async function snapshotEntries(
    currentEntries: readonly FileEntry[],
  ): Promise<Array<{ path: string; digest: string }>> {
    const rows = await Promise.all(
      currentEntries
        .filter(entry => !excludedPaths.has(entry.path))
        .map(async entry => {
          if (entry.type === 'file') {
            return [
              {
                path: entry.path,
                digest: new Bun.CryptoHasher('sha256')
                  .update(await readFile(entry.path))
                  .digest('hex'),
              },
            ]
          }
          if (entry.type === 'symlink') {
            return [{ path: entry.path, digest: `symlink:${entry.target ?? ''}` }]
          }
          return [
            { path: entry.path, digest: 'directory' },
            ...(await snapshotEntries(await listDirectory(entry.path))),
          ]
        }),
    )
    return rows.flat()
  }

  return (await snapshotEntries(entries)).sort((a, b) => a.path.localeCompare(b.path))
}

export function recordSessionAppPaneSession(args: {
  ledger: StagingResourceLedger
  sessionId: string
  label: string
  cleanup: () => Promise<unknown>
  verify: () => Promise<boolean>
}): void {
  args.ledger.record({
    kind: 'session',
    id: args.sessionId,
    label: args.label,
    cleanup: args.cleanup,
    verify: args.verify,
  })
}

export async function verifyRejectedCwdMoves(args: {
  validCwd: string
  garbageCwd: string
  escapeCwd: string
  loadCwd: (label: 'valid' | 'after-garbage' | 'after-bound-escape') => Promise<string | undefined>
  postCwd: (cwd: string, label: 'garbage' | 'bound-escape') => Promise<CwdResponse>
}): Promise<{ garbageStatus: 422; cwdAfterGarbage: string }> {
  assert.equal(await args.loadCwd('valid'), args.validCwd, 'valid cwd move was not durable')

  const garbage = await args.postCwd(args.garbageCwd, 'garbage')
  assert.equal(garbage.status, 422, 'garbage cwd did not return exact HTTP 422')
  const garbageError = SessionCwdErrorSchema.parse(garbage.body)
  assert.equal(garbageError.reason, 'missing', 'garbage cwd did not report missing')
  const cwdAfterGarbage = await args.loadCwd('after-garbage')
  assert.equal(cwdAfterGarbage, args.validCwd, 'garbage cwd changed the durable session cwd')

  const escaped = await args.postCwd(args.escapeCwd, 'bound-escape')
  assert.equal(escaped.status, 422, 'bound escape did not return exact HTTP 422')
  const escapeError = SessionCwdErrorSchema.parse(escaped.body)
  assert.equal(
    escapeError.reason,
    'outside_agent_anchor',
    'bound escape did not report outside_agent_anchor',
  )
  assert.equal(
    await args.loadCwd('after-bound-escape'),
    args.validCwd,
    'bound escape changed the durable session cwd',
  )

  return { garbageStatus: 422, cwdAfterGarbage: args.validCwd }
}

export async function runSessionAppPaneJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<SessionAppPaneEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'session-app-pane',
    label: 'Session App Pane',
    onProgress: options.onProgress,
    run: async context => await runSessionAppPaneAcceptance(context),
  })
}

export async function runSessionAppPaneAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<SessionAppPaneEvidence> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const suffix = runId.slice(-8).toLowerCase()
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const cwdBefore = 'welcome'
  const agentSlug = `pane-${suffix}`
  const moveMarker = `SESSION_APP_PANE_MOVED_${suffix}`
  const terminalMarker = `SESSION_APP_PANE_RECOVERED_${suffix}`
  const agentTaskMarker = `SESSION_APP_PANE_AGENT_TASK_${suffix}`
  const timedTaskMarker = `SESSION_APP_PANE_TIMED_TASK_${suffix}`

  progress('session-app-pane:discover-app')
  const { app } = await verifyFreshWorkspaceAppsAndFilesApi({
    env: env as LiveEnv,
    workspace,
    apiToken,
    artifacts,
  })
  assert.equal(app.anchorPath, 'welcome/hello-app', 'seeded hello app moved unexpectedly')

  progress('session-app-pane:bind-agent')
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: agentSlug,
    name: `Session Pane ${suffix}`,
    description: `Session app pane acceptance agent for ${runId}.`,
    anchorPath: cwdBefore,
    ledger,
    convex,
    artifacts,
  })

  progress('session-app-pane:create-session')
  const readyMarker = `SESSION_APP_PANE_READY_${suffix}`
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          cwd: cwdBefore,
          prompt: `Reply exactly "${readyMarker}" and do not call tools.`,
        }),
      },
      201,
      'session app pane session create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  recordSessionAppPaneSession({
    ledger,
    sessionId,
    label: `${runId}:session-app-pane:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  assert.equal(created.snapshot.cwd, cwdBefore, 'session did not start outside the app directory')
  assert.equal(created.snapshot.agent?.id, agent.id, 'session did not bind to the welcome agent')
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    snapshot => snapshot.turnStatus === 'complete',
    SESSION_WAIT_MS,
    { artifacts, timeoutLabel: 'session app pane setup terminal' },
  )

  progress('session-app-pane:move')
  // Prompt first, page second: the session page opens its live event stream
  // only for a non-terminal (or catching-up) session, and an idle page has no
  // other refresh rail — a deliberate, pre-existing product trait for
  // externally reactivated sessions (see the spec's choices ledger). Opening
  // the page while the move turn runs both matches how the pane is really
  // used and proves the no-reload rail end to end.
  SessionInputResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          behavior: 'steer',
          prompt: buildSessionAppPaneMovePrompt({
            appName: appDisplayName(app),
            marker: moveMarker,
          }),
        }),
      },
      202,
      'session app pane move prompt',
      artifacts,
    ),
  )

  progress('session-app-pane:open-session')
  markExpectedViewportChange(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const sessionPathname = `/w/${encodeURIComponent(workspace.slug)}/sessions/${encodeURIComponent(sessionId)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}${sessionPathname}`)
  await page.getByText(readyMarker, { exact: true }).first().waitFor({ timeout: SESSION_WAIT_MS })
  const openedUrl = page.url()
  const moved = await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    snapshot => snapshot.cwd === app.anchorPath,
    SESSION_WAIT_MS,
    { artifacts, timeoutLabel: 'session app pane moved snapshot' },
  )
  assert.equal(
    appForCwd(moved.cwd, [app])?.id,
    app.id,
    'shared cwd selector did not resolve the moved session to the seeded app',
  )

  progress('session-app-pane:desktop-pane')
  assert.equal(page.url(), openedUrl, 'session page navigated while waiting for the app pane')
  const pane = page.getByRole('complementary', {
    name: `${appDisplayName(app)} app`,
    exact: true,
  })
  await pane.waitFor({ timeout: SESSION_WAIT_MS })
  const iframe = pane.locator('iframe')
  const appFrame = iframe.contentFrame()
  // The sample app's panel, for the reason given in staging-live-apps-files:
  // `513bb5bb` left `Tasks` on the task list's label and nowhere else.
  await appFrame.getByRole('region', { name: 'Task list', exact: true }).waitFor({
    timeout: SESSION_WAIT_MS,
  })
  // This marker is the moving session's chat reply. The app-content assertions
  // below are deliberately frame-scoped so outer chat text cannot satisfy them.
  await page.getByText(moveMarker, { exact: true }).first().waitFor({ timeout: SESSION_WAIT_MS })
  const paneUrlBefore = page.url()
  const frameDocumentToken = crypto.randomUUID()
  await appFrame.locator(':root').evaluate((root, token) => {
    Reflect.set(root.ownerDocument, '__duetSessionAppPaneDocumentToken', token)
  }, frameDocumentToken)

  progress('session-app-pane:snapshot-source')
  const sourceBefore = await loadAppSourceSnapshot({
    base,
    anchorPath: app.anchorPath,
    apiToken,
    artifacts,
  })

  progress('session-app-pane:create-mutation-session')
  const mutationCreatedRaw = await apiJson<unknown>(
    `${base}/agent/sessions`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        cwd: cwdBefore,
        prompt: buildSessionAppPaneMutationPrompt(agentTaskMarker),
      }),
    },
    201,
    'session app pane mutation session create',
    artifacts,
  )
  const mutationSessionId = untrustedSessionId(mutationCreatedRaw)
  recordSessionAppPaneSession({
    ledger,
    sessionId: mutationSessionId,
    label: `${runId}:session-app-pane-mutation:${mutationSessionId}`,
    cleanup: async () =>
      await deleteStagingSession(env, workspace.slug, mutationSessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  const mutationCreated = SessionCreateResponseSchema.parse(mutationCreatedRaw)
  assert.notEqual(mutationSessionId, sessionId, 'mutation reused the pane session identity')
  assert.equal(
    mutationCreated.snapshot.cwd,
    cwdBefore,
    'mutation session did not start outside the app folder',
  )
  assert.equal(
    mutationCreated.snapshot.agent?.id,
    agent.id,
    'mutation session did not bind to the app-owning agent scope',
  )

  progress('session-app-pane:agent-mutation')
  const mutationTerminal = await waitForSessionSnapshot(
    env,
    workspace.slug,
    mutationSessionId,
    apiToken,
    snapshot => snapshot.turnStatus !== 'running',
    SESSION_WAIT_MS,
    { artifacts, timeoutLabel: 'session app pane mutation terminal' },
  )
  assert.equal(mutationTerminal.turnStatus, 'complete', 'mutation session did not complete')
  const historyExpectation = {
    readmePathSuffix: `${app.anchorPath}/README.md`,
    loopbackUrl: `http://127.0.0.1:${app.port}/api/tasks`,
    marker: agentTaskMarker,
  }
  const mutationHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    mutationSessionId,
    apiToken,
    history => history.events.some(row => row.event.type === 'complete'),
    SESSION_WAIT_MS,
  )
  const mutationProof = inspectSessionAppMutationHistory(mutationHistory, historyExpectation)
  const mutationProofSummary = JSON.stringify(mutationProof)
  assert(
    mutationProof.readReadme,
    `mutation history did not prove README discovery: ${mutationProofSummary}`,
  )
  assert(
    mutationProof.calledLoopbackApi,
    `mutation history did not prove the loopback POST: ${mutationProofSummary}`,
  )
  assert(
    mutationProof.readBeforeCall,
    `mutation session called Hello before reading its README: ${mutationProofSummary}`,
  )
  assert(
    mutationProof.narrated,
    `mutation reply did not narrate the task change: ${mutationProofSummary}`,
  )
  await appFrame.getByText(agentTaskMarker, { exact: true }).waitFor({ timeout: SESSION_WAIT_MS })

  const sourceAfter = await loadAppSourceSnapshot({
    base,
    anchorPath: app.anchorPath,
    apiToken,
    artifacts,
  })
  const sourceUnchanged = isDeepStrictEqual(sourceAfter, sourceBefore)
  assert(sourceUnchanged, 'the data mutation changed Hello source files')

  progress('session-app-pane:timed-mutation')
  const timedPost = await appFrame.locator('body').evaluate(async (_body, marker) => {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: marker }),
    })
    const completedAt = Date.now()
    const body = (await response.json()) as { task?: { title?: unknown } }
    return {
      status: response.status,
      title: body.task?.title,
      completedAt,
    }
  }, timedTaskMarker)
  assert.equal(timedPost.status, 201, 'same-origin task mutation did not return HTTP 201')
  assert.equal(timedPost.title, timedTaskMarker, 'same-origin mutation returned the wrong task')
  await appFrame.getByText(timedTaskMarker, { exact: true }).waitFor({ timeout: 5_000 })
  const domLatencyMs = Date.now() - timedPost.completedAt
  assert(domLatencyMs >= 0, 'browser response-completion clock was ahead of the harness clock')
  assert(domLatencyMs <= 5_000, `live task took ${domLatencyMs}ms to reach the pane DOM`)

  const paneUrlAfter = page.url()
  assert.equal(paneUrlAfter, paneUrlBefore, 'session page navigated during live task mutations')
  const frameDocumentUnchanged = await appFrame.locator(':root').evaluate((root, token) => {
    return Reflect.get(root.ownerDocument, '__duetSessionAppPaneDocumentToken') === token
  }, frameDocumentToken)
  assert(frameDocumentUnchanged, 'app iframe document was replaced during live task mutations')

  const desktopScreenshot = path.join(artifacts.directory, 'session-app-pane-desktop.png')
  await page.screenshot({ path: desktopScreenshot, fullPage: true, animations: 'disabled' })

  progress('session-app-pane:mobile-chip')
  markExpectedViewportChange(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', {
      name: `Open ${appDisplayName(app)} app`,
      exact: true,
    })
    .waitFor({ timeout: SESSION_WAIT_MS })
  const mobileScreenshot = path.join(artifacts.directory, 'session-app-pane-mobile-chip.png')
  await page.screenshot({ path: mobileScreenshot, fullPage: true, animations: 'disabled' })

  progress('session-app-pane:reject-invalid-cwd')
  const rejected = await verifyRejectedCwdMoves({
    validCwd: app.anchorPath,
    garbageCwd: `${cwdBefore}/missing-${suffix}`,
    escapeCwd: `${cwdBefore}/..`,
    loadCwd: async label =>
      (
        await loadSessionSnapshot(env, workspace.slug, sessionId, apiToken, {
          artifacts,
          label: `session app pane cwd ${label}`,
        })
      ).cwd,
    postCwd: async cwd => {
      const response = await timedFetch(
        `${base}/agent/sessions/${sessionId}/cwd`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({ cwd }),
        },
        artifacts,
      )
      return { status: response.status, body: await response.json() }
    },
  })

  progress('session-app-pane:terminal-recovery')
  SessionInputResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          behavior: 'steer',
          prompt: `Reply exactly "${terminalMarker}" and do not call tools.`,
        }),
      },
      202,
      'session app pane recovery prompt',
      artifacts,
    ),
  )
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    snapshot => snapshot.turnStatus === 'complete',
    SESSION_WAIT_MS,
    { artifacts, timeoutLabel: 'session app pane recovery terminal' },
  )
  // The recovery proof is the API contract above: the moved session reaches a
  // terminal answer again. The page cannot witness it — its event stream
  // closed at the move turn's terminal frame, and an idle page has no rail
  // for externally delivered prompts (pre-existing trait, see the choices
  // ledger). Assert the marker through the durable history instead.
  const history = await loadChronologicalSessionHistory(
    `${base}/agent/sessions/${sessionId}/history`,
    apiToken,
    'session app pane recovery history',
    artifacts,
  )
  assert(
    JSON.stringify(history.events).includes(terminalMarker),
    'recovery marker missing from durable session history',
  )

  return {
    sessionId,
    mutationSessionId,
    appSlug: app.slug,
    appAnchorPath: app.anchorPath,
    cwdBefore,
    cwdAfter: moved.cwd!,
    garbageStatus: rejected.garbageStatus,
    cwdAfterGarbage: rejected.cwdAfterGarbage,
    terminalMarker,
    agentTaskMarker,
    timedTaskMarker,
    domLatencyMs,
    domLatencyClock: 'response-201',
    paneUrlBefore,
    paneUrlAfter,
    sourceUnchanged,
    narrated: mutationProof.narrated,
    screenshotPaths: [path.basename(desktopScreenshot), path.basename(mobileScreenshot)],
  }
}

function appDisplayName(app: App): string {
  return app.name ?? app.slug
}

function untrustedSessionId(value: unknown): string {
  const sessionId = (value as { session?: { sessionId?: unknown } })?.session?.sessionId
  if (typeof sessionId !== 'string') {
    throw new Error('session create response omitted its resource identity')
  }
  return sessionId
}

async function loadAppSourceSnapshot(args: {
  base: string
  anchorPath: string
  apiToken: string
  artifacts: StagingArtifactCollector
}): Promise<Array<{ path: string; digest: string }>> {
  const listDirectory = async (directoryPath: string): Promise<readonly FileEntry[]> => {
    const listing = FileListResponseSchema.parse(
      await apiJson(
        `${args.base}/files/${directoryPath}?list=1`,
        { headers: bearer(args.apiToken) },
        200,
        'session app pane source listing',
        args.artifacts,
      ),
    )
    return listing.items
  }
  return await captureAppSourceSnapshot(
    await listDirectory(args.anchorPath),
    async filePath => {
      const response = await timedFetch(
        `${args.base}/files/${filePath}`,
        { headers: bearer(args.apiToken) },
        args.artifacts,
      )
      assert.equal(
        response.status,
        200,
        `source read returned HTTP ${response.status}: ${filePath}`,
      )
      return new Uint8Array(await response.arrayBuffer())
    },
    listDirectory,
    new Set([`${args.anchorPath}/tasks.json`]),
  )
}
