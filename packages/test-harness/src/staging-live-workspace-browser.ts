import assert from 'node:assert/strict'
import path from 'node:path'

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import {
  AdminLoginAsRequestSchema,
  WorkspaceSlugSchema,
  normalizeSlug,
  type AdminLoginAsRequest,
} from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForBrowserMagicLink } from './staging-live-browser-acceptance.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { fnMutation, fnQuery, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, errorMessage } from './staging-live-http.ts'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  type StagingCleanupReport,
} from './staging-live-resource-ledger.ts'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { assertWorkspaceCanBecomeActive, waitForWorkspace } from './staging-live-streaming.ts'
import { readWorkspaceJourneyEnv, type WorkspaceJourneyEnv } from './staging-live-workspace-env.ts'

export type WorkspaceBrowserEnv = WorkspaceJourneyEnv & Pick<LiveEnv, 'appUrl' | 'headless'>

export interface WorkspaceBrowserJourneyContext {
  env: WorkspaceBrowserEnv
  page: Page
  workspace: Workspace
  apiToken: string
  email: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress: (stage: string) => void
  vmNames: string[]
}

export interface WorkspaceBrowserJourneyResult<T> {
  journey: string
  runId: string
  artifactDirectory: string
  evidence: T
  vmNames: string[]
  cleanup: StagingCleanupReport
}

export function readWorkspaceBrowserEnv(
  source: NodeJS.ProcessEnv = process.env,
): WorkspaceBrowserEnv {
  const env = readWorkspaceJourneyEnv(source)
  const appUrl = source.DUET_APP_URL?.trim()
  if (!appUrl) throw new Error('Missing required workspace-browser env: DUET_APP_URL')
  const normalizedAppUrl = appUrl.replace(/\/+$/, '')
  if (!new URL(normalizedAppUrl).hostname.includes('staging')) {
    throw new Error('DUET_APP_URL must target a staging hostname')
  }
  return {
    ...env,
    appUrl: normalizedAppUrl,
    headless: source.DUET_E2E_HEADLESS !== '0',
  }
}

export function workspaceBrowserJourneyEmail(runId: string): string {
  return `${runId}-admin@duet.so`
}

export function workspaceBrowserLoginRequest(args: {
  email: string
  name: string
  workspaceSlug?: string
}): AdminLoginAsRequest {
  return AdminLoginAsRequestSchema.parse({
    email: args.email,
    create: true,
    ephemeral: true,
    name:
      args.workspaceSlug === undefined ? args.name : workspaceBrowserOwnerName(args.workspaceSlug),
    ...(args.workspaceSlug === undefined ? {} : { workspaceSlug: args.workspaceSlug }),
    ttlSeconds: 3_600,
  })
}

export function workspaceBrowserOwnerName(workspaceSlug: string): string {
  const slug = WorkspaceSlugSchema.parse(workspaceSlug)
  const suffix = '-s-workspace'
  assert(slug.endsWith(suffix), `Explicit workspace slug must end in ${suffix}`)
  const ownerName = slug.slice(0, -suffix.length)
  assert.equal(
    normalizeSlug(`${ownerName}'s Workspace`),
    slug,
    'Explicit workspace slug must match the login-as bootstrap name',
  )
  return ownerName
}

export async function runWorkspaceBrowserJourney<T>(args: {
  journey: string
  label: string
  workspaceSlug?: string
  entitlement?: 'synthetic-subscription' | 'trial'
  plan?: 'starter' | 'pro' | 'max'
  run: (context: WorkspaceBrowserJourneyContext) => Promise<T>
  onProgress?: (stage: string) => void
  /** Acceptance deadline includes allocation; verified teardown retains its own budget. */
  deadlineAt?: number
}): Promise<WorkspaceBrowserJourneyResult<T>> {
  const budget = (maximum = 300_000) => {
    const remaining = args.deadlineAt === undefined ? maximum : args.deadlineAt - Date.now()
    assert(remaining > 0, 'Workspace journey acceptance deadline expired')
    return Math.min(maximum, remaining)
  }
  budget()
  const env = readWorkspaceBrowserEnv()
  const runId = `staging-e2e-${args.journey}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const artifactDirectory = path.join(env.artifactRoot, runId)
  const progress = (stage: string) => {
    if (stage !== 'cleanup') budget()
    args.onProgress?.(stage)
  }
  const convex = new ConvexHttpClient(env.convexUrl)
  const ledger = new StagingResourceLedger(runId)
  const secrets = [
    env.internalKey,
    env.loginSecret,
    env.vercelBypassSecret,
    process.env.COMPOSIO_API_KEY ?? '',
    process.env.FIRECRAWL_API_KEY ?? '',
  ]
  const artifacts = new StagingArtifactCollector(artifactDirectory, secrets)
  const vmNames: string[] = []
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let evidence: T | undefined
  let cleanup: StagingCleanupReport | undefined
  let primaryError: unknown
  let acceptanceTimer: ReturnType<typeof setTimeout> | undefined

  await artifacts.initialize()
  try {
    progress('login')
    // Drive the same magic-link sign-in the acceptance journey uses, so the
    // browser holds a real @convex-dev/auth session — the web middleware gates
    // protected product paths (including /oauth/authorize) on that JWT, which a
    // planted duet_session cookie does not satisfy. The synthetic identity is a
    // per-run tagged address on the shared AgentMail inbox.
    const inbox = await resolveAgentMailInbox({
      apiKey: env.agentMailApiKey,
      address: env.agentMailInboxAddress,
    })
    const email = taggedInboxAddress(inbox.address, runId)
    const login = await apiJson<{
      token: string
      expiresAt: number
      userId: string
      workspaceSlug: string
    }>(
      `${env.apiUrl}/v1/admin/login-as`,
      {
        method: 'POST',
        signal: args.deadlineAt === undefined ? undefined : AbortSignal.timeout(budget()),
        headers: bearerJson(env.loginSecret),
        body: JSON.stringify(
          workspaceBrowserLoginRequest({
            email,
            name: `${args.label} ${runId}`,
            ...(args.workspaceSlug === undefined ? {} : { workspaceSlug: args.workspaceSlug }),
          }),
        ),
      },
      200,
      'programmatic journey login',
      artifacts,
    )
    secrets.push(login.token)
    ledger.record({
      kind: 'user',
      id: login.userId,
      label: `${runId}:owner:${email}`,
      cleanupPriority: -100,
      cleanup: async () => {
        await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
          internalKey: env.internalKey,
          email,
        })
      },
      verify: async () =>
        (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
          internalKey: env.internalKey,
          email,
        })) === null,
    })

    const whoami = await apiJson<{
      workspaces: Array<{ id: string; slug: string; status: string }>
    }>(
      `${env.apiUrl}/v1/whoami`,
      {
        headers: bearer(login.token),
        signal: args.deadlineAt === undefined ? undefined : AbortSignal.timeout(budget()),
      },
      200,
      'whoami',
      artifacts,
    )
    const seed = whoami.workspaces.find(row => row.slug === login.workspaceSlug)
    assert(seed !== undefined, 'login-as workspace missing from whoami')
    recordWorkspaceCleanup({
      ledger,
      convex,
      env,
      output: { vmNames },
      workspaceId: seed.id,
      slug: seed.slug,
    })
    if (args.entitlement !== 'trial') {
      await convex.mutation(
        fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
        {
          internalKey: env.internalKey,
          email,
          ...(args.plan === undefined ? {} : { plan: args.plan }),
        },
      )
      await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
        internalKey: env.internalKey,
        workspaceId: seed.id,
        amountMicroUsd: 10_000_000,
        type: 'grant',
        reference: `grant:${args.journey}:${crypto.randomUUID()}`,
      })
    }

    progress('workspace:active')
    let workspace = await waitForWorkspace(
      convex,
      env.internalKey,
      seed.id,
      row => {
        assertWorkspaceCanBecomeActive(row)
        return (
          row.status === 'active' &&
          row.vmName !== undefined &&
          row.lastHeartbeatAt !== undefined &&
          row.runtimeVersion !== undefined
        )
      },
      budget(),
    )
    const gateway = (await convex.query(
      fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
      { internalKey: env.internalKey, slug: seed.slug },
    )) as { vmToken: string } | { refusal: 'paused' } | null
    assert(
      gateway !== null && !('refusal' in gateway),
      'active workspace had no gateway connection',
    )
    // Compare live-to-live: staging deploys re-stamp the announced release
    // continuously (concurrent sessions push often), so a manifest snapshot
    // frozen before the wait can never match a VM that converges to a newer
    // announcement. Re-fetch inside the loop; the invariant stays "the VM
    // runs whatever is announced right now".
    workspace = await waitForWorkspace(
      convex,
      env.internalKey,
      seed.id,
      async row => {
        assertWorkspaceCanBecomeActive(row)
        if (row.status !== 'active' || row.runtimeVersion === undefined) return false
        const announced = await readAnnouncedRuntime({
          apiUrl: env.apiUrl,
          vmToken: gateway.vmToken,
          artifacts,
        })
        return row.runtimeVersion === announced.version
      },
      budget(),
    )

    progress('browser')
    browser = await chromium.launch({ headless: env.headless, timeout: budget(120_000) })
    context = await browser.newContext()
    if (args.deadlineAt !== undefined) {
      // Closing the context cancels browser helpers with their own per-step timeouts.
      acceptanceTimer = setTimeout(() => {
        void context?.close().catch(() => undefined)
      }, budget(Number.MAX_SAFE_INTEGER))
    }
    attachBrowserDiagnostics(context, artifacts)
    await installStagingProtection(context, {
      apiUrl: env.apiUrl,
      appUrl: env.appUrl,
      landerUrl: env.appUrl,
      docsUrl: env.appUrl,
      vercelBypassSecret: env.vercelBypassSecret,
    })
    const page = await context.newPage()
    if (args.deadlineAt !== undefined) {
      context.setDefaultTimeout(budget())
      context.setDefaultNavigationTimeout(budget())
    }

    // Sign in for real before the journey runs so the browser carries the
    // convex-auth JWT the web middleware requires on protected product paths.
    const returnTo = `/w/${workspace.slug}/agents`
    const requestedAt = Date.now()
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(
      page,
      `${env.appUrl}/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
    )
    const controls = await waitForHydratedMagicLinkControls(page)
    await controls.email.fill(email)
    const [magicLinkIntent] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/auth/magic-link',
        { timeout: budget(60_000) },
      ),
      controls.submit.click({ noWaitAfter: true, timeout: budget(60_000) }),
    ])
    assert.equal(magicLinkIntent.status(), 204, 'magic-link intent request did not complete')
    const link = await waitForBrowserMagicLink({
      env,
      page,
      ledger,
      email,
      inboxId: inbox.id,
      requestedAt,
      runId,
      returnTo,
      ...(args.deadlineAt === undefined ? {} : { deadlineAt: args.deadlineAt }),
    })
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, link)
    await page.waitForURL(url => url.pathname === returnTo, { timeout: budget(120_000) })
    budget()

    evidence = await args.run({
      env,
      page,
      workspace,
      apiToken: login.token,
      email,
      runId,
      ledger,
      convex,
      artifacts,
      progress,
      vmNames,
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    progress('cleanup')
    if (acceptanceTimer !== undefined) clearTimeout(acceptanceTimer)
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    cleanup = await ledger.cleanupAll()
    await Promise.all([
      artifacts.flushDiagnostics(),
      artifacts.writeJson('journey.json', {
        journey: args.journey,
        runId,
        artifactDirectory,
        evidence,
        vmNames,
        cleanup,
        ...(primaryError === undefined ? {} : { error: errorMessage(primaryError) }),
      }),
    ])
  }

  assert(evidence !== undefined, 'journey completed without evidence')
  assert(cleanup !== undefined, 'journey completed without cleanup evidence')
  if (cleanup.status !== 'pass') {
    throw new Error(`journey cleanup failed: ${JSON.stringify(cleanup)}`)
  }
  return { journey: args.journey, runId, artifactDirectory, evidence, vmNames, cleanup }
}
