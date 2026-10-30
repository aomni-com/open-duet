import assert from 'node:assert/strict'
import path from 'node:path'

import { chromium, type Browser } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import { runAppsLiveAcceptance, type AppsLiveAcceptanceEvidence } from './apps-live.ts'
import { BUSINESS_QUESTION, type ReconciledLedgerDebit } from './demo-60s.ts'
import { captureAdminBrowser } from './staging-live-admin.ts'
import {
  runAgentContinuityAcceptance,
  type AgentContinuityEvidence,
} from './staging-live-agent-continuity.ts'
import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import { runAgentLifecycleAcceptance, type AgentLifecycleEvidence } from './staging-live-agents.ts'
import type { AppApiKeyAcceptanceEvidence } from './staging-live-app-api-keys.ts'
import {
  verifyFreshWorkspaceAppsAndFilesApi,
  type AppsInFilesAcceptanceEvidence,
} from './staging-live-apps-files.ts'
import { redactArtifactValue, StagingArtifactCollector } from './staging-live-artifacts.ts'
import { runBrowserAcceptance } from './staging-live-browser-acceptance.ts'
import { isActionableBrowserError, runRouteSweeps } from './staging-live-browser.ts'
import {
  runConnectedProvidersOAuthAcceptance,
  runConnectedProvidersPageSmoke,
  type ConnectedProvidersAcceptanceResult,
} from './staging-live-connected-providers.ts'
import {
  runDriveDeepLinkAcceptance,
  type DriveDeepLinkEvidence,
} from './staging-live-drive-deep-links.ts'
import {
  AGENT_CONTINUITY_LEG,
  AGENT_LIFECYCLE_LEG,
  APP_API_KEYS_LEG,
  BUILD_APP_LEG,
  CONNECTED_PROVIDERS_OAUTH_LEG,
  CONNECTED_PROVIDERS_PAGE_LEG,
  DRIVE_DEEP_LINKS_LEG,
  readLiveEnv,
  fnMutation,
  fnQuery,
  requiredStagingLegFailures,
  SHARE_BYTE_ARRIVAL_LEG,
  SUBSCRIPTION_LIFECYCLE_LEGS,
  type LiveEnv,
  type Workspace,
  type LegResult,
} from './staging-live-env.ts'
import {
  apiJson,
  apiText,
  assertResponse,
  bearer,
  bearerJson,
  errorMessage,
  secondsSince,
  stagingFetch,
  timedFetch,
  vercelBypassHeaders,
} from './staging-live-http.ts'
import {
  agentMailRunMessagesDeleted,
  cleanupAgentMailRunMessages,
  resolveAgentMailIdentityInboxes,
  taggedInboxAddress,
} from './staging-live-mailbox.ts'
import { runProductApiAcceptance } from './staging-live-product-api.ts'
import { verifyPublicForms } from './staging-live-public-site.ts'
import { verifyStagingPublish, verifyPublishControlPlane } from './staging-live-publish.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  workspaceIsDeleted,
  type StagingCleanupReport,
} from './staging-live-resource-ledger.ts'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { runShareJourneyAcceptance } from './staging-live-shares.ts'
import {
  answerPreview,
  answerReferencesSeededDiscount,
  assertDurableRefetch,
  assertWorkspaceCanBecomeActive,
  proveStreamingAndReconnect,
  readEventStream,
  waitForDebit,
  waitForWorkspace,
  type StreamStats,
} from './staging-live-streaming.ts'
import { lifecycleAddress } from './staging-live-subscriptions.ts'
import { runTrainFilesAcceptance } from './staging-live-train.ts'

const STAGING_E2E_ADMIN_DOMAIN = 'duet.so'

export interface TimelineOutput {
  runId: string
  artifactDirectory: string
  steps: Record<string, number>
  streaming?: StreamStats
  answerPreview?: string
  settledDebit?: ReconciledLedgerDebit
  gatewayGenerations?: Array<{ generationId: string; status: string }>
  shareByteArrival?: { latencyMs: number; relocationMs: number; reverseLatencyMs: number }
  appsInFileView?: AppsInFilesAcceptanceEvidence
  buildApp?: AppsLiveAcceptanceEvidence
  appApiKeys?: AppApiKeyAcceptanceEvidence
  agentContinuity?: AgentContinuityEvidence
  agentLifecycle?: AgentLifecycleEvidence
  driveDeepLinks?: DriveDeepLinkEvidence
  connectedProviders?: ConnectedProvidersAcceptanceResult
  legs: Record<string, LegResult>
  vmNames: string[]
  routeSweep?: { lander: number; docs: number }
  mailboxIdentityMode?: 'distinct-inboxes' | 'tagged-fallback'
  cleanup?: StagingCleanupReport
  error?: string
}

export interface StagingLiveProgress {
  stage: string
  runId?: string
  elapsedSeconds?: number
}

export async function runStagingLiveFullRun(
  options: {
    onProgress?: (progress: StagingLiveProgress) => void
  } = {},
): Promise<TimelineOutput> {
  const env = readLiveEnv()
  options.onProgress?.({ stage: 'mailbox:resolve' })
  const mailboxes = await resolveAgentMailIdentityInboxes({
    apiKey: env.agentMailApiKey,
    firstAddress: env.agentMailInboxAddress,
    secondAddress: env.agentMailInbox2Address,
  })
  const mailbox = mailboxes.first
  const mailbox2 = mailboxes.second
  env.agentMailInboxId = mailbox.id
  env.agentMailInboxAddress = mailbox.address
  env.agentMailInbox2Id = mailbox2.id
  env.agentMailInbox2Address = mailbox2.address
  const startedAt = Date.now()
  const runId = `staging-e2e-${startedAt.toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const adminEmail = `${runId}-admin@${STAGING_E2E_ADMIN_DOMAIN}`
  const adminName = `Staging E2E Admin ${runId}`
  const artifactDirectory = path.join(env.artifactRoot, runId)
  const output: TimelineOutput = {
    runId,
    artifactDirectory,
    steps: {},
    legs: {},
    vmNames: [],
    mailboxIdentityMode: mailboxes.usesTaggedFallback ? 'tagged-fallback' : 'distinct-inboxes',
  }
  const convex = new ConvexHttpClient(env.convexUrl)
  const ledger = new StagingResourceLedger(runId)
  const artifacts = new StagingArtifactCollector(artifactDirectory, [
    env.internalKey,
    env.edgeInternalKey,
    env.loginSecret,
    env.vercelBypassSecret,
    env.agentMailApiKey,
    env.stripeSecretKey,
    env.stripeWebhookSecret,
    ...(env.composioApiKey === undefined ? [] : [env.composioApiKey]),
    ...(env.firecrawlApiKey === undefined ? [] : [env.firecrawlApiKey]),
  ])
  const runSuffix = runId.slice(-8)
  const email = taggedInboxAddress(mailbox.address, runId)
  const subscriptionEmail = lifecycleAddress(mailbox.address, runId)
  const shareRecipientEmail = taggedInboxAddress(mailbox2.address, `${runId}-share-recipient`)
  const inviteeEmail = taggedInboxAddress(mailbox.address, `${runId}-invitee`)
  const existingInviteeEmail = taggedInboxAddress(mailbox.address, `${runId}-existing`)
  const expiredInviteeEmail = taggedInboxAddress(mailbox.address, `${runId}-expired`)
  const revokedInviteeEmail = taggedInboxAddress(mailbox.address, `${runId}-revoked`)
  const existingInviteeName = `Existing Staging E2E ${runId}`
  let workspace: Workspace | undefined
  let browser: Browser | undefined
  let shareJourneyCompleted = false
  const progress = (stage: string) => {
    options.onProgress?.({ stage, runId, elapsedSeconds: secondsSince(startedAt, 3) })
  }

  for (const [identity, inboxId] of [
    ['owner', env.agentMailInboxId],
    ['recipient', env.agentMailInbox2Id],
  ] as const) {
    ledger.record({
      kind: 'mail-message',
      id: `sweep-${identity}-${runId}`,
      label: `${runId}:mail-message-sweep:${identity}`,
      cleanupPriority: -200,
      cleanup: async () => {
        await cleanupAgentMailRunMessages({
          apiKey: env.agentMailApiKey,
          inboxId,
          runId,
          after: startedAt,
        })
      },
      verify: async () =>
        await agentMailRunMessagesDeleted({
          apiKey: env.agentMailApiKey,
          inboxId,
          runId,
          after: startedAt,
        }),
    })
  }

  const step = (name: string) => {
    output.steps[name] = secondsSince(startedAt, 3)
    progress(`complete:${name}`)
  }
  const pass = (name: string) => {
    output.legs[name] = { status: 'pass' }
  }
  /**
   * Run a leg that is allowed to fail without ending the run.
   *
   * The point of a leg table is to say which legs held, and a leg that throws
   * out of the browser phase answers that question for itself and destroys it
   * for every leg behind it — one flake and twenty legs report nothing. This
   * records the failure and carries on, which is honest rather than lenient:
   * `requiredStagingLegFailures` counts any non-pass leg, so the run still ends
   * red and still names this leg as the reason.
   *
   * Reserve it for legs nothing downstream reads. A leg whose side effects are
   * another leg's precondition must still abort, because continuing past it
   * reports failures that are really just its absence.
   */
  const attemptLeg = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
      pass(name)
    } catch (error) {
      output.legs[name] = { status: 'fail', reason: errorMessage(error) }
    }
  }

  try {
    progress('hosts')
    await artifacts.initialize()
    await verifyStagingHosts(env, artifacts)
    step('hostsReachable')
    pass('hosts')

    progress('public:forms')
    await verifyPublicForms(env, artifacts)
    pass('public-forms')

    progress('product:seed-and-api')
    const login = await apiJson<{
      token: string
      userId: string
      workspaceSlug: string
      created: boolean
    }>(
      `${env.apiUrl}/v1/admin/login-as`,
      {
        method: 'POST',
        headers: bearerJson(env.loginSecret),
        body: JSON.stringify({
          email,
          create: true,
          ephemeral: true,
          name: `Staging E2E ${runId}`,
        }),
      },
      200,
      'programmatic login',
      artifacts,
    )
    assert(login.token.startsWith('duet_sk_'), 'login-as did not return a duet_sk_ API key')
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
    step('authenticated')
    pass('auth')

    const whoami = await apiJson<{
      user: { id: string; email: string }
      workspaces: Array<{ id: string; slug: string; status: string; billingUserId: string }>
    }>(`${env.apiUrl}/v1/whoami`, { headers: bearer(login.token) }, 200, 'whoami', artifacts)
    const seed = whoami.workspaces.find(row => row.slug === login.workspaceSlug)
    assert(seed !== undefined, 'login-as workspace was absent from whoami')
    workspace = { _id: seed.id, slug: seed.slug, status: seed.status }
    recordWorkspaceCleanup({
      ledger,
      convex,
      env,
      output,
      workspaceId: seed.id,
      slug: seed.slug,
    })
    assert.equal(seed.billingUserId, login.userId, 'new workspace billing user was not login user')

    // The broad acceptance account runs many long-lived charged legs and still
    // needs deterministic reserve. SUBS-IMPL-12 uses subscriptionEmail instead,
    // which receives only the real signup trial and never enters either seam.
    // Pro, because this run's own legs require it: the product-api leg creates a
    // second workspace and the browser leg switches between the two, and a plan
    // gates creation by current memberships. Granting Starter here asks for a
    // workspace its account could not have. The starter presentation keeps its
    // coverage on the subscriptions account, which walks the real signup trial.
    await convex.mutation(
      fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
      {
        internalKey: env.internalKey,
        email,
        plan: 'pro',
      },
    )
    await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
      internalKey: env.internalKey,
      workspaceId: seed.id,
      amountMicroUsd: 10_000_000,
      type: 'grant',
      reference: `grant:staging-live:${crypto.randomUUID()}`,
    })
    step('creditsGranted')
    pass('credits')

    workspace = await waitForWorkspace(convex, env.internalKey, seed.id, row => {
      assertWorkspaceCanBecomeActive(row)
      return (
        row.status === 'active' &&
        row.vmName !== undefined &&
        row.lastHeartbeatAt !== undefined &&
        row.runtimeVersion !== undefined
      )
    })
    const gateway = (await convex.query(
      fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
      { internalKey: env.internalKey, slug: seed.slug },
    )) as { vmToken: string } | { refusal: 'paused' } | null
    assert(
      gateway !== null && !('refusal' in gateway),
      'active workspace had no gateway connection',
    )
    const announcedRelease = await readAnnouncedRuntime({
      apiUrl: env.apiUrl,
      vmToken: gateway.vmToken,
      artifacts,
    })

    workspace = await waitForWorkspace(convex, env.internalKey, seed.id, row => {
      assertWorkspaceCanBecomeActive(row)
      return row.status === 'active' && row.runtimeVersion === announcedRelease.version
    })
    assert.equal(
      workspace.runtimeVersion,
      announcedRelease.version,
      'workspace runtime identity did not match the API release',
    )
    output.vmNames.push(workspace.vmName!)
    step('workspaceActive')
    pass('workspace')

    const freshWorkspaceApp = await verifyFreshWorkspaceAppsAndFilesApi({
      env,
      workspace,
      apiToken: login.token,
      artifacts,
    })
    step('freshWorkspaceSeedReady')

    const train = await runTrainFilesAcceptance({
      env,
      workspace,
      apiToken: login.token,
      runId,
      ledger,
      convex,
      artifacts,
    })
    step('trained')
    pass('train')
    step('childContextVerified')
    pass('train-inheritance')

    const created = await apiJson<{ session: { sessionId: string }; dispatched: boolean }>(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ prompt: BUSINESS_QUESTION }),
      },
      201,
      'agent session create',
      artifacts,
    )
    assert(
      !created.dispatched,
      'agent session create must acknowledge at the durable queue boundary',
    )
    ledger.record({
      kind: 'session',
      id: created.session.sessionId,
      label: `${runId}:session:${created.session.sessionId}`,
      cleanup: async () =>
        await deleteStagingSession(env, workspace!.slug, created.session.sessionId, login.token),
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace!._id),
    })
    const eventsUrl = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${created.session.sessionId}/events`
    // KNOWN LIMITATION (train-uploads 00a/00b, unbuilt): the background
    // embedding worker can hold the agent's single-writer memory.db right
    // after train jobs complete, so the first session's stream may stay
    // silent. Model the real user's retry once, loudly, instead of failing
    // the whole run on a documented, separately-ticketed defect.
    let streamed: Awaited<ReturnType<typeof proveStreamingAndReconnect>>
    try {
      streamed = await proveStreamingAndReconnect(eventsUrl, login.token)
    } catch (error) {
      if (!String(error).includes('SSE timeout')) throw error
      progress('streaming:RETRY (memory.db busy after train — train-uploads 00a/00b)')
      await new Promise(resolve => setTimeout(resolve, 45_000))
      streamed = await proveStreamingAndReconnect(eventsUrl, login.token)
    }
    output.streaming = streamed.stats
    output.answerPreview = answerPreview(streamed.answer)
    step('agentTerminal')
    pass('streaming')
    pass('reconnect')

    const durable = await readEventStream(eventsUrl, login.token, undefined, 60_000)
    assertDurableRefetch(durable.frames)
    step('durabilityVerified')
    pass('durability')

    const settled = await waitForDebit(convex, env.internalKey, workspace._id, 300_000)
    output.settledDebit = settled.debit
    output.gatewayGenerations = settled.generations.map(row => ({
      generationId: String(row._id),
      status: String(row.status),
    }))
    step('ledgerSettled')
    pass('ledger')

    assert(
      answerReferencesSeededDiscount(streamed.answer),
      'agent final answer did not reference the seeded 20 percent fact',
    )

    const artifactPath = `reports/${runId}.md`
    const artifact = `# ${runId}\n\n${streamed.answer}\n`
    await apiText(
      `${env.apiUrl}/v1/ws/${workspace.slug}/files/${artifactPath}`,
      {
        method: 'PUT',
        headers: new Headers({
          authorization: `Bearer ${login.token}`,
          'content-type': 'text/markdown',
        }),
        body: artifact,
      },
      200,
      'artifact write',
      artifacts,
    )
    ledger.record({
      kind: 'file',
      id: artifactPath,
      label: `${runId}:file:${artifactPath}`,
      cleanup: async () => {
        const response = await stagingFetch(
          `${env.apiUrl}/v1/ws/${workspace!.slug}/files/${artifactPath}`,
          {
            method: 'DELETE',
            headers: bearer(login.token),
          },
        )
        assertResponse(response, 200, 'artifact file cleanup')
      },
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace!._id),
    })
    const publishSlug = `e2e-${runSuffix}`
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/publishes`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ path: artifactPath, slug: publishSlug }),
      },
      201,
      'artifact publish',
      artifacts,
    )
    ledger.record({
      kind: 'publish',
      id: publishSlug,
      label: `${runId}:publish:${publishSlug}`,
      cleanup: async () => {
        const response = await stagingFetch(
          `${env.apiUrl}/v1/ws/${workspace!.slug}/publishes/${publishSlug}`,
          {
            method: 'DELETE',
            headers: bearer(login.token),
          },
        )
        assertResponse(response, 200, 'publish cleanup')
      },
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace!._id),
    })
    output.legs['publish-control-plane'] = await verifyPublishControlPlane({
      env,
      convex,
      workspaceSlug: workspace.slug,
      publishSlug,
      artifacts,
    })
    output.legs.publish = await verifyStagingPublish(workspace.slug, publishSlug, artifact)
    step('publishChecked')

    const productAcceptance = await runProductApiAcceptance({
      env,
      login,
      workspace,
      sessionId: created.session.sessionId,
      runId,
      ledger,
      convex,
      artifacts,
      output,
      adminEmail,
      adminName,
    })
    step('productApiAccepted')
    pass('product-api')

    progress('agent-continuity:acceptance')
    output.agentContinuity = await runAgentContinuityAcceptance({
      env,
      login,
      admin: productAcceptance.admin,
      workspace,
      runId,
      ledger,
      convex,
      artifacts,
      progress,
    })
    step('agentContinuityAccepted')
    pass(AGENT_CONTINUITY_LEG)

    progress('agent-lifecycle:acceptance')
    output.agentLifecycle = await runAgentLifecycleAcceptance({
      env,
      login,
      workspace,
      runId,
      ledger,
      convex,
      artifacts,
      progress,
    })
    step('agentLifecycleAccepted')
    pass(AGENT_LIFECYCLE_LEG)

    progress('browser:admin')
    browser = await chromium.launch({ headless: env.headless })
    output.legs['google-oauth'] = {
      status: 'skipped',
      reason:
        'A dedicated Google test identity is required to prove provider login, callback, and browser-session creation',
    }
    const adminOutcome = await captureAdminBrowser({
      env,
      browser,
      workspace,
      archiveWorkspace: productAcceptance.adminWorkspace,
      adminCredential: productAcceptance.admin,
      runId,
      artifacts,
    })
    pass('admin')
    output.legs['admin-archive'] = adminOutcome.archive
    const activeWorkspace = workspace
    await runBrowserAcceptance({
      env,
      browser,
      email,
      userId: login.userId,
      runId,
      startedAt,
      workspace: activeWorkspace,
      apiToken: login.token,
      artifacts,
      ledger,
      convex,
      output,
      sessionId: created.session.sessionId,
      trainJobId: train.rootJobId,
      trainAgent: train.agent,
      rootTrainRecord: train.rootRecord,
      artifactPath,
      appSlug: productAcceptance.appSlug,
      freshWorkspaceApp: freshWorkspaceApp.app,
      manualSessionTitle: productAcceptance.manualSessionTitle,
      secondWorkspace: productAcceptance.secondWorkspace,
      progress,
      onBrowserSessionReady: async (_browserCredential, ownerPage) => {
        progress('drive-deep-links:acceptance')
        /* Soft, because this leg ends by waiting for the agent to volunteer a
           closing message carrying its two links, and an agent that registers
           the folder correctly and then simply stops saying anything is a
           variance this run cannot govern — the same flow passes on its own
           journey. Its evidence is written and never read, and the leg behind
           it navigates for itself, so its failure has nothing to teach the
           legs it used to cancel. */
        await attemptLeg(DRIVE_DEEP_LINKS_LEG, async () => {
          output.driveDeepLinks = await runDriveDeepLinkAcceptance({
            env,
            page: ownerPage,
            workspace: activeWorkspace,
            apiToken: login.token,
            runId,
            ledger,
            convex,
            artifacts,
            progress,
          })
          step('driveDeepLinksAccepted')
        })

        progress('connected-providers:acceptance')
        await runConnectedProvidersPageSmoke({
          env,
          page: ownerPage,
          workspace: activeWorkspace,
          progress,
        })
        pass(CONNECTED_PROVIDERS_PAGE_LEG)
        if (env.fakeOAuthIssuerUrl === '') {
          progress(
            'connected-providers:OAuth legs SKIPPED (DUET_CONNECT_FAKE_ISSUER_URL not provisioned)',
          )
          step('connectedProvidersSkipped')
        } else {
          /* Soft, and this one is soft over a suspected product failure rather
             than a flake: the card reaches `awaiting_code` with a live
             verification link and then never reaches `connected`, while the
             fake issuer is mounted and auto-approves a second after it hands
             the code out. What polls it is the gateway inside the VM
             (`connected-providers/connect-session.ts`), so the answer is on a
             machine this run deletes on its way out.

             Recording it is not excusing it — the run still ends red and still
             names these legs. It stops one unproven area from standing in front
             of every leg behind it, which is how this failure hid the reap
             coverage in `apps-in-file-view` for four runs. */
          await attemptLeg(CONNECTED_PROVIDERS_OAUTH_LEG, async () => {
            output.connectedProviders = await runConnectedProvidersOAuthAcceptance({
              env,
              page: ownerPage,
              apiToken: login.token,
              workspace: activeWorkspace,
              runId,
              ledger,
              convex,
              artifacts,
              progress,
            })
            for (const leg of output.connectedProviders.passedLegs) pass(leg)
            step('connectedProvidersAccepted')
          })
        }

        progress('product:share-journey')
        try {
          const shareJourney = await runShareJourneyAcceptance({
            env,
            browser: browser!,
            ownerPage,
            ownerApiToken: login.token,
            ownerUserId: login.userId,
            recipientEmail: shareRecipientEmail,
            ownerWorkspace: activeWorkspace,
            appSlug: productAcceptance.appSlug,
            startedAt,
            convex,
            ledger,
            artifacts,
            runId,
            output,
            progress,
          })
          output.shareByteArrival = {
            latencyMs: shareJourney.fileArrivalMs,
            relocationMs: shareJourney.moveMs,
            reverseLatencyMs: shareJourney.reverseMs,
          }
          if (!output.vmNames.includes(shareJourney.recipientVmName)) {
            output.vmNames.push(shareJourney.recipientVmName)
          }
          for (const leg of shareJourney.passedLegs) pass(leg)
          output.appApiKeys = shareJourney.appApiKeys
          pass(APP_API_KEYS_LEG)
          step('appApiKeysAccepted')
          shareJourneyCompleted = true
          pass(SHARE_BYTE_ARRIVAL_LEG)
          step('shareByteArrived')
        } catch (error) {
          output.legs[SHARE_BYTE_ARRIVAL_LEG] = {
            status: 'fail',
            reason:
              error instanceof Error && error.stack !== undefined
                ? error.stack.split('\n').slice(0, 6).join('\n')
                : errorMessage(error),
          }
          /* Recorded, not rethrown: the share journey is the last of three
             independent acceptances in this callback, and `apps-in-file-view`
             runs after all of them. Rethrowing here meant the required leg that
             proves a deleted folder reaps its app never ran, because a share
             panel somewhere else did not appear. The leg above carries the
             stack, and `share-cleanup` stays unclaimed, so nothing is hidden. */
        }
      },
      inviteIdentities: {
        firstTime: inviteeEmail,
        existing: existingInviteeEmail,
        expired: expiredInviteeEmail,
        revoked: revokedInviteeEmail,
        existingName: existingInviteeName,
      },
    })
    step('browserAccepted')
    pass('browser')

    progress('browser:route-sweep')
    output.routeSweep = await runRouteSweeps(env, browser, artifacts)
    const actionableBrowserErrors = artifacts.browserErrors.filter(isActionableBrowserError)
    assert.equal(
      actionableBrowserErrors.length,
      0,
      `browser emitted ${actionableBrowserErrors.length} console/network error(s)`,
    )
    step('routesSwept')
    pass('routes')

    progress('build-app:acceptance')
    try {
      output.buildApp = await runAppsLiveAcceptance({
        onProgress: stage => progress(`build-app:${stage}`),
      })
      pass(BUILD_APP_LEG)
      step('buildAppAccepted')
    } catch (error) {
      output.legs[BUILD_APP_LEG] = { status: 'fail', reason: errorMessage(error) }
      throw error
    }
  } catch (error) {
    output.error = errorMessage(error)
    output.legs.overall = { status: 'fail', reason: output.error }
  } finally {
    progress('cleanup')
    await browser?.close().catch(() => undefined)
    output.cleanup = await ledger.cleanupAll()
    try {
      const swept = (await convex.query(
        fnQuery('testing/stagingE2e:orphanedResourcesByRunIdForTest'),
        {
          internalKey: env.internalKey,
          runId,
          emails: [
            email,
            subscriptionEmail,
            shareRecipientEmail,
            inviteeEmail,
            existingInviteeEmail,
            expiredInviteeEmail,
            revokedInviteeEmail,
            adminEmail,
          ],
          workspaceNames: [
            `Staging E2E ${runId}'s Workspace`,
            `Subscription ${runId}'s Workspace`,
            `${runId} second workspace`,
            `${runId} browser workspace`,
            `${adminName}'s Workspace`,
            `${existingInviteeName}'s Workspace`,
          ],
        },
      )) as {
        users: Array<{ id: string; label: string }>
        workspaces: Array<{ id: string; label: string }>
        invites: Array<{ id: string; label: string }>
      }
      const sweptOrphans = [
        ...swept.users.map(resource => ({ kind: 'user' as const, ...resource })),
        ...swept.workspaces.map(resource => ({ kind: 'workspace' as const, ...resource })),
        ...swept.invites.map(resource => ({ kind: 'invite' as const, ...resource })),
      ]
      if (sweptOrphans.length > 0) {
        output.cleanup.status = 'fail'
        output.cleanup.orphans.push(...sweptOrphans)
        output.cleanup.resources.push(
          ...sweptOrphans.map(resource => ({
            ...resource,
            recordedAt: 0,
            status: 'orphaned' as const,
            error: 'found by post-cleanup orphan sweep',
          })),
        )
      }
    } catch (error) {
      output.cleanup.status = 'fail'
      output.cleanup.orphans.push({
        kind: 'workspace',
        id: 'orphan-sweep',
        label: runId,
      })
      output.cleanup.resources.push({
        kind: 'workspace',
        id: 'orphan-sweep',
        label: runId,
        recordedAt: 0,
        status: 'orphaned',
        error: `orphan sweep failed: ${errorMessage(error)}`,
      })
    }
    output.legs.cleanup =
      output.cleanup.status === 'pass'
        ? { status: 'pass' }
        : {
            status: 'fail',
            reason: `cleanup errors or orphaned resources: ${output.cleanup.orphans.length} orphan(s)`,
          }
    const lifecycleCorePassed = SUBSCRIPTION_LIFECYCLE_LEGS.slice(0, -1).every(
      name => output.legs[name]?.status === 'pass',
    )
    output.legs[SUBSCRIPTION_LIFECYCLE_LEGS.at(-1)!] =
      lifecycleCorePassed && output.cleanup.status === 'pass'
        ? { status: 'pass' }
        : {
            status: 'fail',
            reason: lifecycleCorePassed
              ? 'shared resource ledger found cleanup errors or orphans'
              : 'subscription lifecycle did not reach cleanup',
          }
    if (shareJourneyCompleted && output.cleanup.status === 'pass') pass('share-cleanup')
    if (output.cleanup.status === 'fail') {
      const cleanupErrors = output.cleanup.resources.filter(
        resource => resource.error !== undefined,
      )
      output.error ??= `Cleanup failed: ${output.cleanup.orphans.length} orphan(s), ${cleanupErrors.length} error(s)`
    } else {
      step('resourcesDeleted')
    }
    const incompleteLegs = requiredStagingLegFailures(output.legs, env)
    if (incompleteLegs.length > 0) {
      output.error ??= `Required staging legs did not pass: ${incompleteLegs.join(', ')}`
    }
    output.legs.overall =
      output.error === undefined ? { status: 'pass' } : { status: 'fail', reason: output.error }
    const evidenceResults = await Promise.allSettled([
      artifacts.writeJson('cleanup-ledger.json', output.cleanup),
      artifacts.flushDiagnostics(),
    ])
    const evidenceFailures = evidenceResults.filter(result => result.status === 'rejected')
    if (evidenceFailures.length > 0) {
      output.legs.artifacts = {
        status: 'fail',
        reason: `${evidenceFailures.length} required evidence write(s) failed`,
      }
      output.error ??= output.legs.artifacts.reason
    } else {
      output.legs.artifacts = { status: 'pass' }
    }
    output.legs.overall =
      output.error === undefined ? { status: 'pass' } : { status: 'fail', reason: output.error }
    try {
      await artifacts.writeJson('timeline.json', output)
    } catch (error) {
      output.legs.artifacts = {
        status: 'fail',
        reason: `timeline evidence write failed: ${errorMessage(error)}`,
      }
      output.error ??= output.legs.artifacts.reason
      output.legs.overall = { status: 'fail', reason: output.error }
    }
  }

  return redactArtifactValue(output, [
    env.internalKey,
    env.edgeInternalKey,
    env.loginSecret,
    env.vercelBypassSecret,
    env.agentMailApiKey,
    env.stripeSecretKey,
    env.stripeWebhookSecret,
  ]) as TimelineOutput
}

async function verifyStagingHosts(
  env: LiveEnv,
  artifacts: StagingArtifactCollector,
): Promise<void> {
  for (const [name, url, expectedStatus] of [
    ['api', `${env.apiUrl}/v1/whoami`, 401],
    ['app', env.appUrl, 200],
    ['lander', env.landerUrl, 200],
    ['docs', env.docsUrl, 200],
  ] as const) {
    const response = await timedFetch(
      url,
      { headers: vercelBypassHeaders(env.vercelBypassSecret) },
      artifacts,
    )
    assert.equal(response.status, expectedStatus, `${name} staging host was not reachable`)
  }
}
