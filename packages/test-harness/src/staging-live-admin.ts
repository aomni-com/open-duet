import assert from 'node:assert/strict'
import path from 'node:path'

import { type Browser, type Locator, type Page } from '@playwright/test'

import {
  InternalAdminWorkspaceDetailSchema,
  type InternalAdminWorkspaceSummary,
  WhoamiResponseSchema,
} from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForFinishedBrowserResponse } from './staging-live-browser-response.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  markExpectedViewportChange,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import type { LiveEnv, Workspace } from './staging-live-env.ts'
import { apiText, waitForWorkspace } from './staging-live-http.ts'
import { assertWorkspaceCanBecomeActive } from './staging-live-streaming.ts'

const SLOW_ADMIN_OPERATION_TIMEOUT_MS = 360_000
const SLOW_ADMIN_POLL_MS = 3_000

export async function captureAdminBrowser(args: {
  env: LiveEnv
  browser: Browser
  workspace: Workspace
  archiveWorkspace: Workspace
  adminCredential: { token: string; expiresAt: number; prefix: string }
  runId: string
  artifacts: StagingArtifactCollector
}): Promise<{ archive: { status: 'pass' } | { status: 'fail'; reason: string } }> {
  const { env, browser, workspace, archiveWorkspace, adminCredential, runId, artifacts } = args
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installStagingProtection(context, env)
  attachBrowserDiagnostics(context, artifacts, {
    responses: [
      {
        method: 'GET',
        origin: new URL(env.appUrl).origin,
        pathname: '/api/duet/user/billing',
        status: 403,
        remaining: 1,
      },
    ],
  })
  await context.addCookies([
    {
      name: 'duet_session',
      value: Buffer.from(JSON.stringify(adminCredential), 'utf8').toString('base64url'),
      url: env.appUrl,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires: Math.floor(adminCredential.expiresAt / 1_000),
    },
  ])
  const page = await context.newPage()
  let accepted = false
  let stage = 'initial load'
  try {
    await navigateDeployedPage(page, `${env.appUrl}/internal-admin`)
    assert(!page.url().includes('/sign-in'), 'internal admin browser session was rejected')
    const identity = await page.evaluate(async () => {
      const response = await fetch('/api/duet/whoami')
      return { status: response.status, body: await response.json() }
    })
    assert.equal(identity.status, 200, 'admin browser identity request was rejected')
    assert.equal(
      WhoamiResponseSchema.parse(identity.body).internalAdmin,
      true,
      'admin browser identity lost internal-admin access',
    )
    const search = page.locator('input[type="search"], input').first()
    const retry = page.getByRole('button', { name: 'Try again', exact: true })
    await search.or(retry).waitFor({ state: 'visible' })
    if (!(await search.isVisible())) {
      await retry.click()
      try {
        await search.waitFor({ state: 'visible', timeout: 30_000 })
      } catch (error) {
        await artifacts.writeJson('internal-admin-browser.json', await adminBrowserState(page))
        throw error
      }
    }
    await page.screenshot({
      path: path.join(artifacts.directory, 'internal-admin-loaded.png'),
      fullPage: true,
    })
    await artifacts.writeJson('internal-admin-browser.json', await adminBrowserState(page))
    stage = 'workspace search'
    await search.fill(workspace.slug)
    await Promise.all([
      waitForFinishedBrowserResponse(page, 'GET', '/api/duet/internal-admin/search'),
      page.getByRole('button', { name: 'Search', exact: true }).click(),
    ])
    const workspaceResult = page
      .locator('[data-admin-result="workspace"]')
      .filter({ hasText: workspace.slug })
      .first()
    await workspaceResult.waitFor()
    await workspaceResult.click()
    const workspaceQuery = page.locator('[data-admin-query="workspace"]')
    await waitForBrowserQueryData(workspaceQuery)
    await page.getByText('Per-member usage', { exact: true }).waitFor()
    await page.getByText('Recent ledger', { exact: true }).waitFor()
    const recentLedger = page
      .getByRole('heading', { name: 'Recent ledger', exact: true })
      .locator('..')

    const auditEvidence: Array<{ operation: string; auditId: string }> = []
    const reason = page.getByLabel('Audit reason')
    await reason.fill(`Staging browser acceptance ${runId}`)
    stage = 'servicing controls absence'
    assert.equal(
      await page.getByRole('combobox', { name: 'Servicing status' }).count(),
      0,
      'manual servicing status control is still present',
    )
    assert.equal(
      await page.getByRole('button', { name: /^(Pause|Activate)$/ }).count(),
      0,
      'manual pause/activate action is still present',
    )

    stage = 'credit adjustment'
    const credit = page.getByPlaceholder('25.00')
    await page.getByText('Paid reserve', { exact: true }).waitFor()
    await credit.fill('0.01')
    auditEvidence.push({
      operation: 'credit-added',
      auditId: await runAdminWorkspaceMutation(page, workspace._id, workspaceQuery, () =>
        page.getByRole('button', { name: 'Apply', exact: true }).click(),
      ),
    })
    const creditedAdjustment = recentLedger.locator(
      '[data-ledger-type="adjustment"][data-ledger-amount-micro-usd="10000"]',
    )
    await creditedAdjustment.waitFor()
    await creditedAdjustment.getByText('$0.01', { exact: true }).waitFor()
    stage = 'credit restore'
    await credit.fill('-0.01')
    auditEvidence.push({
      operation: 'credit-restored',
      auditId: await runAdminWorkspaceMutation(page, workspace._id, workspaceQuery, () =>
        page.getByRole('button', { name: 'Apply', exact: true }).click(),
      ),
    })
    const restoredAdjustment = recentLedger.locator(
      '[data-ledger-type="adjustment"][data-ledger-amount-micro-usd="-10000"]',
    )
    await restoredAdjustment.waitFor()
    await restoredAdjustment.getByText('-$0.01', { exact: true }).waitFor()

    stage = 'runtime inspection'
    const vmPath = `/api/duet/internal-admin/workspaces/${workspace._id}/vm`
    const filesPath = `/api/duet/internal-admin/workspaces/${workspace._id}/files`
    await Promise.all([
      waitForFinishedBrowserResponse(page, 'GET', vmPath),
      waitForFinishedBrowserResponse(page, 'GET', filesPath),
      page.getByRole('button', { name: /VM, gateway, files, and command console/ }).click(),
    ])
    await page.getByRole('heading', { name: 'Runtime health', exact: true }).waitFor()
    await page.getByText('Reachable', { exact: true }).waitFor()
    await page.getByRole('heading', { name: 'Filesystem', exact: true }).waitFor()
    const reports = page.getByRole('button', { name: 'reports', exact: true })
    await reports.waitFor()
    await reports.click()
    const artifactName = `${runId}.md`
    const artifact = page.getByRole('button', { name: artifactName, exact: true })
    await artifact.waitFor()
    await Promise.all([
      waitForFinishedBrowserResponse(
        page,
        'GET',
        `/api/duet/internal-admin/workspaces/${workspace._id}/file`,
      ),
      artifact.click(),
    ])
    await page.getByText(runId, { exact: false }).last().waitFor()
    await page.getByRole('button', { name: '.. / reports', exact: true }).click()

    stage = 'guarded command'
    const command = page.getByRole('combobox', { name: 'Guarded command' })
    await command.selectOption('uptime')
    const commandResult = waitForAdminOperation(
      page,
      `/api/duet/internal-admin/workspaces/${workspace._id}/command`,
    )
    await page.getByRole('button', { name: 'Run command', exact: true }).click()
    auditEvidence.push({ operation: 'command-uptime', auditId: await commandResult })
    await page
      .locator('pre')
      .filter({ hasNotText: 'Command output appears here.' })
      .last()
      .waitFor()

    let archiveFailure: string | undefined
    try {
      stage = 'archive workspace provisioning'
      const archiveWorkspacePath = `/api/duet/internal-admin/workspaces/${archiveWorkspace._id}`
      await waitForActiveAdminWorkspace(
        archiveWorkspace._id,
        async () => {
          const body = await page.evaluate(async workspacePath => {
            const response = await fetch(workspacePath)
            if (!response.ok) throw new Error(`admin workspace returned HTTP ${response.status}`)
            return await response.json()
          }, archiveWorkspacePath)
          return InternalAdminWorkspaceDetailSchema.parse(body).workspace
        },
        { timeoutMs: SLOW_ADMIN_OPERATION_TIMEOUT_MS, pollMs: SLOW_ADMIN_POLL_MS },
      )
      // The gateway's tar step 500s on a workspace whose drive dir has never
      // been written (fleet gateway behavior; hardening tracked in the spec).
      // Seeding one file also makes the archive→resume files-intact check real.
      await apiText(
        `${env.apiUrl}/v1/ws/${archiveWorkspace.slug}/files/archive-fixture/${runId}.txt`,
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${adminCredential.token}` },
          body: `archive fixture ${runId}`,
        },
        200,
        'seed archive fixture file',
        artifacts,
      )
      // archive-now fails closed (502) when the VM's gateway cannot serve the
      // archive yet; a freshly provisioned fixture needs gateway readiness, not
      // just active/active — and, when the run knows the announced release,
      // the constructed runtime identity (a fresh VM can activate the
      // announced inventory on its first sync polls).
      {
        const expectedRuntime = process.env.DUET_EXPECTED_RUNTIME_VERSION
        const deadline = Date.now() + SLOW_ADMIN_OPERATION_TIMEOUT_MS
        for (;;) {
          const state = await page.evaluate(
            async ([vmStatusPath, workspacePath]) => {
              const [vmResponse, detailResponse] = await Promise.all([
                fetch(vmStatusPath),
                fetch(workspacePath),
              ])
              const vm = vmResponse.ok
                ? ((await vmResponse.json()) as { gateway?: { reachable?: boolean } })
                : undefined
              const detail = detailResponse.ok
                ? ((await detailResponse.json()) as {
                    workspace?: { runtimeVersion?: string }
                  })
                : undefined
              return {
                reachable: vm?.gateway?.reachable === true,
                runtimeVersion: detail?.workspace?.runtimeVersion,
              }
            },
            [`${archiveWorkspacePath}/vm`, archiveWorkspacePath] as const,
          )
          if (
            state.reachable &&
            (expectedRuntime === undefined || state.runtimeVersion === expectedRuntime)
          )
            break
          if (Date.now() >= deadline)
            throw new Error(
              `archive workspace runtime never became ready (reachable=${state.reachable}, version=${state.runtimeVersion ?? 'unknown'}, expected=${expectedRuntime ?? 'any'})`,
            )
          await Bun.sleep(SLOW_ADMIN_POLL_MS)
        }
      }

      stage = 'archive workspace search/open'
      await page.getByRole('button', { name: 'Back to results', exact: true }).click()
      await search.fill(archiveWorkspace.slug)
      await Promise.all([
        waitForFinishedBrowserResponse(page, 'GET', '/api/duet/internal-admin/search'),
        page.getByRole('button', { name: 'Search', exact: true }).click(),
      ])
      await page
        .locator('[data-admin-result="workspace"]')
        .filter({ hasText: archiveWorkspace.slug })
        .first()
        .click()
      await waitForBrowserQueryData(workspaceQuery)
      await page.getByRole('button', { name: /VM, gateway, files, and command console/ }).click()
      await reason.fill(`Staging browser acceptance ${runId}`)

      stage = 'archive VM now'
      const archivePath = `/api/duet/internal-admin/workspaces/${archiveWorkspace._id}/vm/archive`
      const archive = waitForAdminOperation(page, archivePath, {
        timeoutMs: SLOW_ADMIN_OPERATION_TIMEOUT_MS,
      })
      await page.getByRole('button', { name: 'Archive VM now', exact: true }).click()
      auditEvidence.push({ operation: 'vm-archive-now', auditId: await archive })
      await waitForArchivedPausedAdminProjection(
        async () => {
          const body = await page.evaluate(async workspacePath => {
            const response = await fetch(workspacePath)
            if (!response.ok) throw new Error(`admin projection returned HTTP ${response.status}`)
            return await response.json()
          }, archiveWorkspacePath)
          const detail = InternalAdminWorkspaceDetailSchema.parse(body)
          return {
            status: detail.workspace.status,
            servicingStatus: detail.workspace.servicingStatus,
          }
        },
        { timeoutMs: SLOW_ADMIN_OPERATION_TIMEOUT_MS, pollMs: SLOW_ADMIN_POLL_MS },
      )
      await page.screenshot({
        path: path.join(artifacts.directory, 'internal-admin-operations.png'),
        fullPage: true,
      })
    } catch (error) {
      // The archive rail is reported as its own leg so its repairs never
      // block the rest of the acceptance (or the subscription lifecycle).
      archiveFailure = `stage ${stage}: ${String(error).slice(0, 300)}`
      await captureAdminFailureEvidence(page, artifacts, stage)
      await navigateDeployedPage(page, `${env.appUrl}/internal-admin`)
      await page.locator('input[type="search"], input').first().waitFor({ state: 'visible' })
    }

    stage = 'feedback queries'
    await page.getByRole('button', { name: 'Feedback', exact: true }).click()
    await page.getByRole('heading', { name: 'Feedback triage', exact: true }).waitFor()
    const feedbackQuery = page.locator('[data-admin-query="feedback"]')
    await waitForBrowserQueryData(feedbackQuery, 'active')
    await page.getByRole('button', { name: 'Archived feedback', exact: true }).click()
    await waitForBrowserQueryData(feedbackQuery, 'archived')
    await page.getByRole('button', { name: 'Active feedback', exact: true }).click()
    await waitForBrowserQueryData(feedbackQuery, 'active')
    stage = 'free-credit query'
    await page.getByRole('button', { name: 'Free credits', exact: true }).click()
    await waitForBrowserQueryData(page.locator('[data-admin-query="free-credits"]'))
    await page.getByText('Outstanding free credits', { exact: true }).waitFor()
    await page.getByText('Outstanding value', { exact: true }).waitFor()
    await artifacts.writeJson('internal-admin-audit-evidence.json', auditEvidence)
    await page.screenshot({
      path: path.join(artifacts.directory, 'internal-admin-desktop.png'),
      fullPage: true,
    })
    markExpectedViewportChange(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: path.join(artifacts.directory, 'internal-admin-mobile.png'),
      fullPage: true,
    })
    accepted = true
    return {
      archive:
        archiveFailure === undefined
          ? { status: 'pass' as const }
          : { status: 'fail' as const, reason: archiveFailure },
    }
  } catch (error) {
    await captureAdminFailureEvidence(page, artifacts, stage)
    throw error
  } finally {
    if (accepted) {
      for (const openPage of context.pages()) markExpectedBrowserTransition(openPage)
    }
    await context.close()
  }
}

async function captureAdminFailureEvidence(
  page: Page,
  artifacts: StagingArtifactCollector,
  stage: string,
): Promise<void> {
  const workspaceQuery = page.locator('[data-admin-query="workspace"]')
  const payerBalance = page.getByText('Paid reserve', { exact: true }).locator('..')
  await Promise.allSettled([
    page.screenshot({
      path: path.join(artifacts.directory, 'internal-admin-failure.png'),
      fullPage: true,
      mask: [page.locator('[data-admin-query="feedback"] article'), page.getByRole('dialog')],
    }),
    (async () => {
      await artifacts.writeJson('internal-admin-failure.json', {
        stage,
        browser: await adminBrowserState(page).catch(() => undefined),
        workspaceQuery: {
          status: await workspaceQuery
            .getAttribute('data-query-status', { timeout: 1_000 })
            .catch(() => undefined),
          fetchStatus: await workspaceQuery
            .getAttribute('data-fetch-status', { timeout: 1_000 })
            .catch(() => undefined),
        },
        payerBalance: await payerBalance.textContent({ timeout: 1_000 }).catch(() => undefined),
        visibleButtons: await page
          .getByRole('button')
          .allTextContents()
          .then(rows => rows.filter(text => text.trim().length > 0).slice(0, 60))
          .catch(() => undefined),
        bodyText: await page
          .locator('body')
          .innerText({ timeout: 2_000 })
          .then(text => text.slice(0, 4_000))
          .catch(() => undefined),
      })
    })(),
  ]).then(results => {
    const failed = results.filter(result => result.status === 'rejected')
    if (failed.length > 0)
      console.warn('admin failure capture incomplete:', failed.map(String).join('; '))
  })
}

async function runAdminWorkspaceMutation(
  page: Page,
  workspaceId: string,
  workspaceQuery: Locator,
  action: () => Promise<unknown>,
): Promise<string> {
  const workspacePath = `/api/duet/internal-admin/workspaces/${workspaceId}`
  const [auditId] = await Promise.all([
    waitForAdminOperation(page, workspacePath),
    waitForFinishedBrowserResponse(page, 'GET', workspacePath),
    action(),
  ])
  await waitForBrowserQueryData(workspaceQuery)
  return auditId
}

type BrowserQueryLocator = Pick<Locator, 'getAttribute' | 'isVisible' | 'textContent'>

export async function waitForBrowserQueryData(
  locator: BrowserQueryLocator,
  expectedVariant?: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  for (;;) {
    const attributeTimeout = Math.max(1, Math.min(1_000, deadline - Date.now()))
    let variant: string | null
    let status: string | null
    let visible: boolean
    let renderedText: string | null
    try {
      ;[variant, status, visible, renderedText] = await Promise.all([
        locator.getAttribute('data-query-variant', { timeout: attributeTimeout }),
        locator.getAttribute('data-query-status', { timeout: attributeTimeout }),
        locator.isVisible({ timeout: attributeTimeout }),
        locator.textContent({ timeout: attributeTimeout }),
      ])
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for browser query data', { cause: error })
      }
      await Bun.sleep(options.pollMs ?? 100)
      continue
    }
    if (
      (expectedVariant === undefined || variant === expectedVariant) &&
      status === 'success' &&
      visible &&
      renderedText?.trim()
    )
      return
    if (status === 'error') throw new Error('Browser query entered an error state')
    if (Date.now() >= deadline) throw new Error('Timed out waiting for browser query data')
    await Bun.sleep(options.pollMs ?? 100)
  }
}

export async function waitForArchivedPausedAdminProjection<
  T extends Pick<InternalAdminWorkspaceSummary, 'status' | 'servicingStatus'>,
>(
  readProjection: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? SLOW_ADMIN_OPERATION_TIMEOUT_MS)
  let projection: T
  for (;;) {
    projection = await readProjection()
    if (projection.status === 'archived' && projection.servicingStatus === 'paused') {
      return projection
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for archived-paused admin projection; last state was ${projection.status}/${projection.servicingStatus}`,
      )
    }
    await Bun.sleep(options.pollMs ?? SLOW_ADMIN_POLL_MS)
  }
}

export async function waitForActiveAdminWorkspace<
  T extends Pick<InternalAdminWorkspaceSummary, 'id' | 'status' | 'servicingStatus'>,
>(
  workspaceId: string,
  readWorkspace: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  return await waitForWorkspace({
    workspaceId,
    load: async () => {
      const workspace = await readWorkspace()
      assertWorkspaceCanBecomeActive({ _id: workspace.id, status: workspace.status })
      return workspace
    },
    predicate: workspace => workspace.status === 'active' && workspace.servicingStatus === 'active',
    timeoutMs: options.timeoutMs ?? SLOW_ADMIN_OPERATION_TIMEOUT_MS,
    pollMs: options.pollMs ?? SLOW_ADMIN_POLL_MS,
    summarize: workspace =>
      workspace === undefined
        ? undefined
        : {
            id: workspace.id,
            status: workspace.status,
            servicingStatus: workspace.servicingStatus,
          },
  })
}

async function waitForAdminOperation(
  page: Page,
  pathname: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const response = await page.waitForResponse(
    candidate =>
      candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === pathname,
    { timeout: options.timeoutMs },
  )
  assert(response.ok(), `admin UI operation ${pathname} returned HTTP ${response.status()}`)
  const body = (await response.json()) as { auditId?: unknown }
  const auditId = body.auditId
  if (typeof auditId !== 'string') {
    throw new Error(`admin UI operation ${pathname} omitted auditId`)
  }
  return auditId
}

async function adminBrowserState(page: Page): Promise<unknown> {
  return await page.evaluate(() => ({
    readyState: document.readyState,
    resources: performance
      .getEntriesByType('resource')
      .map(entry => new URL(entry.name).pathname)
      .filter(pathname => pathname.startsWith('/api/duet/')),
  }))
}
