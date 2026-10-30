import assert from 'node:assert/strict'

import type { Page } from '@playwright/test'
import type { ConvexHttpClient } from 'convex/browser'

import { AgentListResponseSchema, SessionCreateResponseSchema, type Agent } from '@repo/contract'

import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import type { LiveEnv, Workspace } from './staging-live-env.ts'
import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { workspaceIsDeleted, type StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const REGISTRATION_WAIT_MS = 240_000
const POLL_MS = 1_000

export interface DriveDeepLinkEvidence {
  sessionId: string
  agentId: string
  agentSlug: string
  anchorPath: string
  emittedHref: string
  landedPathname: string
  percentFilePaths: [string, string]
}

export interface DrivePercentIdentityEvidence {
  percentFilePaths: [string, string]
}

export type DriveDeepLinkLiveEnv = Pick<LiveEnv, 'apiUrl' | 'appUrl' | 'internalKey'>

export async function runDriveDeepLinksJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<DriveDeepLinkEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'drive-deep-links',
    label: 'Drive Deep Links',
    onProgress: options.onProgress,
    run: async context => await runDriveDeepLinkAcceptance(context),
  })
}

export async function runDrivePercentIdentitiesJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<DrivePercentIdentityEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'drive-percent-identities',
    label: 'Drive Percent Identities',
    onProgress: options.onProgress,
    run: async context =>
      await runDrivePercentIdentityAcceptance({
        ...context,
        anchorPath: '',
        surface: 'browser-proxy',
      }),
  })
}

/**
 * Independent staging oracle. This deliberately re-derives the web grammar:
 * the harness cannot import app code, and the sibling test mirrors the web
 * canonical path table to make drift visible.
 */
export function emittedLinkMatchesAnchor(
  evidence: Pick<DriveDeepLinkEvidence, 'emittedHref' | 'anchorPath'>,
  workspaceSlug: string,
): boolean {
  const encodedAnchor = encodeDrivePathForUrl(evidence.anchorPath)
  if (encodedAnchor === null) return false
  const expected = `/w/${encodeURIComponent(workspaceSlug)}/files/${encodedAnchor}`
  return evidence.emittedHref === expected
}

export function buildDriveDeepLinkAgentPrompt(input: {
  runId: string
  slug: string
  name: string
}): string {
  const anchorPath = `agents/${input.slug}`
  return [
    `This is the deterministic Drive deep-link acceptance run ${input.runId}.`,
    'Use the manage-agents skill to create and register exactly one agent with:',
    `- slug: ${input.slug}`,
    `- display name: ${input.name}`,
    `- anchor folder: ${anchorPath}`,
    `Give ${anchorPath}/AGENTS.md a one-sentence instruction identifying ${input.runId}.`,
    'Do not stop before registration succeeds and the registered agent is visible.',
    'Your final response must contain both the agent-page link and the Drive folder link taught by manage-agents.',
    `Use the exact display text "${input.name}" for the Drive folder link.`,
    'Do not emit an absolute origin or a query-parameter path.',
  ].join('\n')
}

export async function runDriveDeepLinkAcceptance(args: {
  env: DriveDeepLinkLiveEnv
  page: Page
  workspace: Workspace
  apiToken: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress: (stage: string) => void
}): Promise<DriveDeepLinkEvidence> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = args
  const suffix = runId.slice(-8).toLowerCase()
  const agentSlug = `drive-link-${suffix}`
  const agentName = `Drive Link ${suffix}`
  const expectedAnchorPath = `agents/${agentSlug}`
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  progress('drive-deep-links:create-session')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          prompt: buildDriveDeepLinkAgentPrompt({
            runId,
            slug: agentSlug,
            name: agentName,
          }),
        }),
      },
      201,
      'drive deep-link agent session create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:drive-deep-links-session:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })

  progress('drive-deep-links:wait-for-registration')
  const agent = await waitForRegisteredAgent({
    base,
    token: apiToken,
    slug: agentSlug,
    anchorPath: expectedAnchorPath,
    artifacts,
  })
  ledger.record({
    kind: 'agent',
    id: agent.id,
    label: `${runId}:drive-deep-links-agent:${agentSlug}`,
    cleanup: async () => {
      const response = await stagingFetch(`${base}/agents/${agentSlug}`, {
        method: 'DELETE',
        headers: bearer(apiToken),
      })
      assert(
        [200, 404, 502].includes(response.status),
        `drive deep-link agent cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })

  progress('drive-deep-links:rendered-link')
  const sessionPathname = `/w/${encodeURIComponent(workspace.slug)}/sessions/${encodeURIComponent(sessionId)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}${sessionPathname}`)
  const namedLinks = page.getByRole('link', { name: agentName, exact: true })
  const link = namedLinks.and(page.locator('a[href*="/files/"]'))
  await link.waitFor({ timeout: REGISTRATION_WAIT_MS })
  assert.equal(
    await link.count(),
    1,
    'session did not render exactly one Drive folder link for the agent display name',
  )
  const emittedHref = await link.getAttribute('href')
  assert(emittedHref !== null, 'rendered Drive folder link had no href')
  assert(
    emittedLinkMatchesAnchor({ emittedHref, anchorPath: agent.anchorPath }, workspace.slug),
    `rendered Drive folder href did not match the registered anchor: ${emittedHref}`,
  )

  progress('drive-deep-links:click')
  const contextCount = page.context().pages().length
  const expectedPathname = expectedDriveFolderHref(workspace.slug, agent.anchorPath)
  await Promise.all([
    page.waitForURL(url => url.pathname === expectedPathname, {
      timeout: REGISTRATION_WAIT_MS,
    }),
    link.click(),
  ])
  assert.equal(
    page.context().pages().length,
    contextCount,
    'Drive folder link opened a new browsing context',
  )
  await assertFilesFolder(page, agent.anchorPath, agentSlug)
  await page.getByRole('button', { name: 'AGENTS.md', exact: true }).waitFor()

  progress('drive-deep-links:reload')
  await page.reload()
  await page.waitForURL(url => url.pathname === expectedPathname)
  await assertFilesFolder(page, agent.anchorPath, agentSlug)

  const { percentFilePaths } = await runDrivePercentIdentityAcceptance({
    env,
    page,
    workspace,
    apiToken,
    runId,
    ledger,
    convex,
    artifacts,
    progress,
    anchorPath: agent.anchorPath,
    surface: 'files-ui',
  })

  progress('drive-deep-links:not-found-recovery')
  const missingSegment = `missing-${suffix}`
  const missingPathname = `${expectedPathname}/${encodeURIComponent(missingSegment)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}${missingPathname}`)
  await page.waitForURL(url => url.pathname === missingPathname)
  await page.locator('[data-files-not-found]').waitFor()
  await page.locator('[data-files-open-parent]').click()
  await page.waitForURL(url => url.pathname === expectedPathname)
  await assertFilesFolder(page, agent.anchorPath, agentSlug)

  return {
    sessionId,
    agentId: agent.id,
    agentSlug: agent.slug,
    anchorPath: agent.anchorPath,
    emittedHref,
    landedPathname: page.url().startsWith(env.appUrl)
      ? new URL(page.url()).pathname
      : expectedPathname,
    percentFilePaths,
  }
}

export async function runDrivePercentIdentityAcceptance(args: {
  env: DriveDeepLinkLiveEnv
  page: Page
  workspace: Workspace
  apiToken: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress: (stage: string) => void
  anchorPath: string
  surface: 'browser-proxy' | 'files-ui'
}): Promise<DrivePercentIdentityEvidence> {
  const {
    env,
    page,
    workspace,
    apiToken,
    runId,
    ledger,
    convex,
    artifacts,
    progress,
    anchorPath,
    surface,
  } = args
  const suffix = runId.slice(-8).toLowerCase()
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  progress('drive-deep-links:percent-identities')
  const percentFiles = [
    {
      name: `100%-${suffix}.txt`,
      content: `literal-percent:${runId}`,
    },
    {
      name: `a%2Fb-${suffix}.txt`,
      content: `encoded-separator-text:${runId}`,
    },
  ] as const
  const pathPrefix = anchorPath.length === 0 ? '' : `${anchorPath}/`
  const percentFilePaths: [string, string] = [
    `${pathPrefix}${percentFiles[0].name}`,
    `${pathPrefix}${percentFiles[1].name}`,
  ]
  for (const [index, file] of percentFiles.entries()) {
    const path = percentFilePaths[index]!
    const encodedPath = encodeDrivePathForUrl(path)
    assert(encodedPath !== null, `percent identity fixture produced malformed path: ${path}`)
    await apiText(
      `${base}/files/${encodedPath}`,
      {
        method: 'PUT',
        headers: new Headers({
          authorization: `Bearer ${apiToken}`,
          'content-type': 'text/plain',
        }),
        body: file.content,
      },
      200,
      `drive deep-link percent file write: ${file.name}`,
      artifacts,
    )
    ledger.record({
      kind: 'file',
      id: path,
      label: `${runId}:drive-deep-links-file:${path}`,
      cleanup: async () => {
        const response = await stagingFetch(`${base}/files/${encodedPath}`, {
          method: 'DELETE',
          headers: bearer(apiToken),
        })
        assert(
          [200, 404].includes(response.status),
          `drive deep-link percent file cleanup returned HTTP ${response.status}`,
        )
      },
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
    })

    if (surface === 'browser-proxy') {
      await assertBrowserProxyTextFile(
        page,
        `${env.appUrl}/api/duet/ws/${encodeURIComponent(workspace.slug)}/files/${encodedPath}`,
        file.name,
        file.content,
      )
    } else {
      const filePathname = `/w/${encodeURIComponent(workspace.slug)}/files/${encodedPath}`
      markExpectedBrowserTransition(page)
      await navigateDeployedPage(page, `${env.appUrl}${filePathname}`)
      await page.waitForURL(url => url.pathname === filePathname)
      await assertFilesTextFile(page, anchorPath, file.name, file.content)

      await page.reload()
      await page.waitForURL(url => url.pathname === filePathname)
      await assertFilesTextFile(page, anchorPath, file.name, file.content)
    }
  }

  return { percentFilePaths }
}

async function assertBrowserProxyTextFile(
  page: Page,
  url: string,
  fileName: string,
  content: string,
): Promise<void> {
  markExpectedBrowserTransition(page)
  const initial = await navigateDeployedPage(page, url)
  assert.equal(initial?.status(), 200, `browser proxy could not read ${fileName}`)
  assert.equal(await initial.text(), content, `browser proxy loaded the wrong file: ${fileName}`)

  markExpectedBrowserTransition(page)
  const reloaded = await page.reload()
  assert.equal(reloaded?.status(), 200, `browser proxy could not reload ${fileName}`)
  assert.equal(await reloaded.text(), content, `browser proxy reloaded the wrong file: ${fileName}`)
}

export function encodeDrivePathForUrl(anchorPath: string): string | null {
  if (
    anchorPath.length === 0 ||
    anchorPath.startsWith('/') ||
    anchorPath.endsWith('/') ||
    anchorPath.includes('\\') ||
    anchorPath.includes('\0')
  ) {
    return null
  }
  const segments = anchorPath.split('/')
  if (
    segments.some(
      segment => segment.length === 0 || segment === '.' || segment === '..' || segment === '.duet',
    )
  ) {
    return null
  }
  return segments.map(encodeURIComponent).join('/')
}

function expectedDriveFolderHref(workspaceSlug: string, anchorPath: string): string {
  const encodedAnchor = encodeDrivePathForUrl(anchorPath)
  assert(encodedAnchor !== null, `registered agent returned malformed anchor path: ${anchorPath}`)
  return `/w/${encodeURIComponent(workspaceSlug)}/files/${encodedAnchor}`
}

async function assertFilesTextFile(
  page: Page,
  anchorPath: string,
  fileName: string,
  content: string,
): Promise<void> {
  const surface = page.locator('[data-files-surface]')
  await surface.waitFor()
  await page.waitForFunction(
    expectedPath =>
      document.querySelector('[data-files-surface]')?.getAttribute('data-files-path') ===
      expectedPath,
    `/${anchorPath}`,
    { timeout: REGISTRATION_WAIT_MS },
  )
  const preview = page.locator('[data-files-preview]')
  await preview.waitFor()
  /* The name is in the document's header, which stands in the drive's own
     breadcrumb row when there is width to put it there — so it is looked up by
     the header's marker rather than through the body. */
  await page
    .locator('[data-files-preview-header]')
    .getByRole('heading', { name: fileName, exact: true })
    .waitFor()
  const editor = preview.locator('textarea')
  await editor.waitFor()
  assert.equal(
    await editor.inputValue(),
    content,
    `Drive preview loaded the wrong file: ${fileName}`,
  )
}

async function waitForRegisteredAgent(args: {
  base: string
  token: string
  slug: string
  anchorPath: string
  artifacts: StagingArtifactCollector
}): Promise<Agent> {
  const deadline = Date.now() + REGISTRATION_WAIT_MS
  let lastAnchorPath: string | undefined
  for (;;) {
    const roster = AgentListResponseSchema.parse(
      await apiJson(
        `${args.base}/agents`,
        { headers: bearer(args.token) },
        200,
        'drive deep-link agent roster',
        args.artifacts,
      ),
    )
    const agent = roster.items.find(candidate => candidate.slug === args.slug)
    if (agent?.anchorPath === args.anchorPath) return agent
    lastAnchorPath = agent?.anchorPath
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for Drive deep-link agent registration: ${JSON.stringify({
          slug: args.slug,
          expectedAnchorPath: args.anchorPath,
          lastAnchorPath,
        })}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

async function assertFilesFolder(page: Page, anchorPath: string, slug: string): Promise<void> {
  const browserPath = `/${anchorPath}`
  const surface = page.locator('[data-files-surface]')
  await surface.waitFor()
  await page.waitForFunction(
    expectedPath =>
      document.querySelector('[data-files-surface]')?.getAttribute('data-files-path') ===
      expectedPath,
    browserPath,
    { timeout: REGISTRATION_WAIT_MS },
  )
  assert.equal(
    await surface.getAttribute('data-files-path'),
    browserPath,
    'Files surface did not settle on the registered anchor folder',
  )
  /* The columns browser's trail — labeled "Drive path", each crumb a button
     named for its folder. The list view's nav was labeled "Breadcrumb"; the
     columns view is what a deep-linked folder opens in now. */
  await page
    .getByRole('navigation', { name: 'Drive path' })
    .getByRole('button', { name: slug, exact: true })
    .waitFor()
}
