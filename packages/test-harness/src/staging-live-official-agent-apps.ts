import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { expect } from '@playwright/test'

import {
  AgentConfigSchema,
  AppResponseSchema,
  WorkspaceSlugSchema,
  normalizeSlug,
  type App,
} from '@repo/contract'
import {
  loadOfficialSeedFiles,
  officialSeedAgents,
  type OfficialSeedAgent,
} from '@repo/official-agents-seed'

import {
  loadOfficialAgentsIntoWorkspace,
  type OfficialAgentWorkspaceLoadResult,
  type OfficialAgentWorkspaceSeedFile,
} from './official-agent-workspace.ts'
import { markStagingAgentOnboarded } from './staging-live-agent-fixture.ts'
import {
  isActionableBrowserError,
  markExpectedBrowserTransition,
  markExpectedViewportChange,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { apiJson, bearer } from './staging-live-http.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser.ts'

type OfficialAppDeclaration = NonNullable<OfficialSeedAgent['apps']>[number]

export interface OfficialAgentAppJourneyPlanItem {
  sourceAgentSlug: string
  sourceAppSlug: string
  sourceAppPath: string
  agentSlug: string
  appSlug: string
  route: string
  launchPath: string
  heading: string
  readinessSelector: string
}

export interface OfficialAgentAppEvidence extends OfficialAgentAppJourneyPlanItem {
  appId: string
  anchorPath: string
  anchorState: App['anchorState']
  runtimeStatus: App['runtimeStatus']
  semanticAssertion: string
  screenshots: {
    desktop: { product: string; iframe: string }
    mobile: { product: string; iframe: string }
  }
}

export interface OfficialAgentAppsJourneyEvidence {
  loadedAgents: Array<{
    sourceSlug: string
    registeredSlug: string
    reset: OfficialAgentWorkspaceLoadResult['reset']
    fileCount: number
  }>
  apps: OfficialAgentAppEvidence[]
  browserDiagnostics: { actionableErrors: number }
  onboardingUnlockedAgentSlugs: string[]
}

type OfficialAppState = Pick<
  App,
  'id' | 'slug' | 'anchorPath' | 'anchorState' | 'runtimeStatus' | 'reconciliationError'
>

export function officialAppOwningAgents(agents: readonly OfficialSeedAgent[]): OfficialSeedAgent[] {
  return agents.filter(agent => (agent.apps?.length ?? 0) > 0)
}

export function officialAgentAppsWorkspaceSlug(
  runIdentity: string,
  agents: readonly OfficialSeedAgent[],
): string {
  const appSlugs = officialAppOwningAgents(agents).flatMap(agent =>
    (agent.apps ?? []).map(app => app.slug),
  )
  assert(appSlugs.length > 0, 'Official app journey requires at least one manifest app')
  const longestAppSlug = Math.max(...appSlugs.map(slug => Buffer.byteLength(slug, 'utf8')))
  const workspaceLabelBudget = 63 - Buffer.byteLength('--', 'utf8') - longestAppSlug
  const prefix = 'official-'
  const bootstrapSuffix = '-s-workspace'
  assert(
    workspaceLabelBudget > prefix.length + bootstrapSuffix.length,
    'Official manifest app slugs leave no room for a unique workspace slug',
  )
  const digest = createHash('sha256').update(runIdentity).digest('hex')
  const workspaceSlug = WorkspaceSlugSchema.parse(
    normalizeSlug(
      `${prefix}${digest.slice(0, workspaceLabelBudget - prefix.length - bootstrapSuffix.length)}'s Workspace`,
    ),
  )
  for (const appSlug of appSlugs) {
    assert(
      Buffer.byteLength(`${appSlug}--${workspaceSlug}`, 'utf8') <= 63,
      `Official app host label exceeded 63 bytes for ${appSlug}`,
    )
  }
  return workspaceSlug
}

export function buildOfficialAgentAppJourneyPlan(args: {
  workspaceSlug: string
  loads: readonly OfficialAgentWorkspaceLoadResult[]
  seedFiles: readonly OfficialAgentWorkspaceSeedFile[]
}): OfficialAgentAppJourneyPlanItem[] {
  const files = new Map(args.seedFiles.map(file => [file.path, file.bytes]))
  return args.loads.flatMap(load => {
    assertRegistrationMatchesManifest(load)
    return (load.sourceAgent.apps ?? []).map(sourceApp => {
      const returned = load.registered.apps.find(app => app.path === sourceApp.path)
      assert(
        returned !== undefined,
        `Registration omitted manifest app ${load.sourceAgent.slug}/${sourceApp.slug}`,
      )
      return {
        sourceAgentSlug: load.sourceAgent.slug,
        sourceAppSlug: sourceApp.slug,
        sourceAppPath: sourceApp.path,
        agentSlug: load.registered.agent.slug,
        appSlug: returned.slug,
        route: officialAgentAppRoute(args.workspaceSlug, load.registered.agent.slug, returned.slug),
        launchPath: officialAppLaunchPath(args.workspaceSlug, returned.slug),
        ...authoredAppSemantics(sourceApp, files),
      }
    })
  })
}

export function officialAgentAppRoute(
  workspaceSlug: string,
  agentSlug: string,
  appSlug: string,
): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(agentSlug)}/apps/${encodeURIComponent(appSlug)}`
}

export function officialAppsAreReconciled(
  plan: readonly OfficialAgentAppJourneyPlanItem[],
  apps: readonly OfficialAppState[],
): boolean {
  assert.equal(apps.length, plan.length, 'Official app state count differed from journey plan')
  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index]!
    const expected = plan[index]!
    assert.equal(app.slug, expected.appSlug, 'Official app state order changed')
    if (app.runtimeStatus === 'reconcile_failed') {
      throw new Error(
        `Official app ${app.slug} reconciliation failed: ${app.reconciliationError ?? 'unknown gateway error'}`,
      )
    }
    if (
      app.anchorPath !== expected.sourceAppPath ||
      app.anchorState !== 'active' ||
      app.runtimeStatus !== 'reconciled'
    ) {
      return false
    }
  }
  return true
}

export function officialAppLaunchPath(workspaceSlug: string, appSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(appSlug)}/launch`
}

export function officialAppStateTextIsSettled(text: string): boolean {
  return !/^(?:Loading|Checking)/i.test(text.trim())
}

export function officialOnboardingAgentSlugs(
  loads: readonly OfficialAgentWorkspaceLoadResult[],
  seedFiles: readonly OfficialAgentWorkspaceSeedFile[],
): string[] {
  const files = new Map(seedFiles.map(file => [file.path, file.bytes]))
  return loads.flatMap(load => {
    const bytes = files.get(`${load.sourceAgent.path}/agent.json`)
    if (bytes === undefined) return []
    const config = AgentConfigSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    // Any declared onboarding locks the card, and this journey is about the
    // apps behind it — not about onboarding, which has its own journey. Keyed on
    // the block's presence rather than its kind: the official agents moved from
    // app onboarding to chat, and a kind check silently stopped unlocking
    // anything while still returning a list-shaped answer.
    return config.onboarding === undefined ? [] : [load.registered.agent.slug]
  })
}

export async function runOfficialAgentAppsJourney(
  args: {
    onProgress?: (stage: string) => void
  } = {},
) {
  return await runWorkspaceBrowserJourney({
    journey: 'official-agent-apps',
    label: 'Official agent apps',
    workspaceSlug: officialAgentAppsWorkspaceSlug(crypto.randomUUID(), officialSeedAgents),
    onProgress: args.onProgress,
    run: runOfficialAgentAppsAcceptance,
  })
}

async function runOfficialAgentAppsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<OfficialAgentAppsJourneyEvidence> {
  const { env, page, workspace, apiToken, artifacts, progress } = context
  const sourceAgents = officialAppOwningAgents(officialSeedAgents)
  const seedFiles = loadOfficialSeedFiles()

  progress('official-agent-apps:load')
  const loads = await loadOfficialAgentsIntoWorkspace({
    apiUrl: env.apiUrl,
    workspaceSlug: workspace.slug,
    token: apiToken,
    seedFiles,
    agents: sourceAgents,
    reset: true,
  })
  const plan = buildOfficialAgentAppJourneyPlan({
    workspaceSlug: workspace.slug,
    loads,
    seedFiles,
  })

  progress('official-agent-apps:unlock-onboarding')
  const onboardingUnlockedAgentSlugs = officialOnboardingAgentSlugs(loads, seedFiles)
  for (const agentSlug of onboardingUnlockedAgentSlugs) {
    await markStagingAgentOnboarded({ env, workspace, apiToken, slug: agentSlug, artifacts })
  }

  progress('official-agent-apps:reconcile')
  const reconciled = await waitForOfficialApps({ context, plan })
  const apps: OfficialAgentAppEvidence[] = plan.map((item, index) => ({
    ...item,
    appId: reconciled[index]!.id,
    anchorPath: reconciled[index]!.anchorPath,
    anchorState: reconciled[index]!.anchorState,
    runtimeStatus: reconciled[index]!.runtimeStatus,
    semanticAssertion: `${item.heading} heading and ${item.readinessSelector}`,
    screenshots: officialAppScreenshotNames(item),
  }))

  for (const viewport of [
    { name: 'desktop' as const, width: 1440, height: 900 },
    { name: 'mobile' as const, width: 390, height: 844 },
  ]) {
    progress(`official-agent-apps:${viewport.name}`)
    markExpectedViewportChange(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })

    for (const app of apps) {
      markExpectedBrowserTransition(page)
      const response = await navigateDeployedPage(page, `${env.appUrl}${app.route}`)
      assert(response?.ok(), `${app.route} failed product navigation`)

      const appRow = reconciled.find(row => row.id === app.appId)
      assert(appRow !== undefined, `Lost reconciled row for ${app.appSlug}`)
      const titledIframe = page
        .locator('iframe')
        .and(page.getByTitle(appRow.name ?? app.appSlug, { exact: true }))
      await titledIframe.waitFor({ timeout: 180_000 })
      assert.equal(await titledIframe.count(), 1, `${app.route} did not have one app iframe`)
      const frameSource = await titledIframe.getAttribute('src')
      assert(frameSource !== null, `${app.route} iframe omitted its private launch-grant source`)
      assert.equal(
        new URL(frameSource, env.appUrl).pathname,
        app.launchPath,
        `${app.route} iframe did not use the exact private launch-grant route`,
      )
      const frame = titledIframe.contentFrame()
      await frame
        .getByRole('heading', { name: app.heading, exact: true })
        .waitFor({ timeout: 180_000 })
      const stateMarker = frame.locator(app.readinessSelector).first()
      await stateMarker.waitFor({ timeout: 180_000 })
      await expect
        .poll(async () => officialAppStateTextIsSettled(await stateMarker.innerText()), {
          message: `${app.appSlug} remained in its loading state`,
          timeout: 180_000,
        })
        .toBe(true)

      const names = app.screenshots[viewport.name]
      const productTarget = path.join(artifacts.directory, names.product)
      const iframeTarget = path.join(artifacts.directory, names.iframe)
      await Promise.all([
        artifacts.reservePrivateFile(productTarget),
        artifacts.reservePrivateFile(iframeTarget),
      ])
      await page.mouse.move(0, 0)
      await page.screenshot({
        path: productTarget,
        fullPage: true,
        animations: 'disabled',
      })
      await titledIframe.screenshot({ path: iframeTarget, animations: 'disabled' })
    }
  }

  markExpectedBrowserTransition(page)
  await page.close()
  const actionableErrors = artifacts.browserErrors.filter(isActionableBrowserError)
  assert.deepEqual(
    actionableErrors,
    [],
    `official app browser diagnostics were not clean: ${JSON.stringify(actionableErrors)}`,
  )
  return {
    loadedAgents: loads.map(load => ({
      sourceSlug: load.sourceAgent.slug,
      registeredSlug: load.registered.agent.slug,
      reset: load.reset,
      fileCount: load.fileCount,
    })),
    apps,
    browserDiagnostics: { actionableErrors: actionableErrors.length },
    onboardingUnlockedAgentSlugs,
  }
}

async function waitForOfficialApps(args: {
  context: WorkspaceBrowserJourneyContext
  plan: readonly OfficialAgentAppJourneyPlanItem[]
}): Promise<App[]> {
  const deadline = Date.now() + 240_000
  let last: App[] = []
  for (;;) {
    last = await Promise.all(
      args.plan.map(async item => {
        const response = await apiJson(
          `${args.context.env.apiUrl}/v1/ws/${encodeURIComponent(args.context.workspace.slug)}/apps/${encodeURIComponent(item.appSlug)}`,
          { headers: bearer(args.context.apiToken) },
          200,
          `${item.appSlug} official app lookup`,
          args.context.artifacts,
        )
        return AppResponseSchema.parse(response).app
      }),
    )
    if (officialAppsAreReconciled(args.plan, last)) {
      return last
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for official apps to reconcile: ${JSON.stringify(last.map(app => ({ slug: app.slug, anchorState: app.anchorState, runtimeStatus: app.runtimeStatus })))}`,
      )
    }
    await Bun.sleep(2_000)
  }
}

function authoredAppSemantics(
  app: OfficialAppDeclaration,
  files: ReadonlyMap<string, Uint8Array>,
): Pick<OfficialAgentAppJourneyPlanItem, 'heading' | 'readinessSelector'> {
  const bytes = files.get(`${app.path}/page.html`)
  assert(bytes !== undefined, `Official app ${app.slug} omitted page.html from generated content`)
  const html = new TextDecoder().decode(bytes)
  const match = html.match(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i)
  assert(match?.[1] !== undefined, `Official app ${app.slug} page.html omitted an h1`)
  const heading = match[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  assert(heading.length > 0, `Official app ${app.slug} page.html had an empty h1`)
  const readinessSelector = html.includes('class="pill waiting"') ? '.pill' : '.empty:not([hidden])'
  return { heading, readinessSelector }
}

function assertRegistrationMatchesManifest(load: OfficialAgentWorkspaceLoadResult): void {
  const expected = (load.sourceAgent.apps ?? []).map(app => app.path).sort()
  const actual = load.registered.apps.map(app => app.path).sort()
  assert.deepEqual(
    actual,
    expected,
    `Registration response app paths differed for ${load.sourceAgent.slug}`,
  )
}

export function officialAppScreenshotNames(item: OfficialAgentAppJourneyPlanItem) {
  const stem = `${item.sourceAgentSlug}--${item.sourceAppSlug}`
  return {
    desktop: {
      product: `${stem}--desktop--product.png`,
      iframe: `${stem}--desktop--iframe.png`,
    },
    mobile: {
      product: `${stem}--mobile--product.png`,
      iframe: `${stem}--mobile--iframe.png`,
    },
  }
}
