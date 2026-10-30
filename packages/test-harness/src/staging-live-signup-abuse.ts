import assert from 'node:assert/strict'
import path from 'node:path'

import { chromium, type Browser, type BrowserContext } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForBrowserMagicLink } from './staging-live-browser-acceptance.ts'
import {
  attachBrowserDiagnostics,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { fnMutation, fnQuery, readLiveEnv } from './staging-live-env.ts'
import { waitForBrowserSessionCredential } from './staging-live-invite.ts'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  type StagingCleanupReport,
} from './staging-live-resource-ledger.ts'
import { waitForWorkspace } from './staging-live-streaming.ts'

/**
 * Proves the signup gate FIRES, not that the happy path survives.
 *
 * A journey asserting "signup still works" says nothing about a gate — the
 * interesting claim is that a signup we expect to be refused actually is, and
 * that it leaves evidence behind. Both legs run from the same real browser
 * against deployed staging.
 *
 * Both addresses deliver to the one AgentMail inbox. Only the exempt leg carries
 * the `staging-e2e-` marker, which is what `classifySignupIdentity` requires in
 * addition to a configured inbox — so one mailbox gives us an address the gate
 * waves through and an address it refuses.
 */
export type SignupAbuseEvidence = {
  exempt: { email: string; workspaceReached: boolean }
  withheld: { email: string; reason: string }
}

export async function runSignupAbuseJourney(args: {
  onProgress?: (stage: string) => void
}): Promise<{
  evidence: SignupAbuseEvidence
  vmNames: string[]
  cleanup: StagingCleanupReport
}> {
  const env = readLiveEnv()
  const runId = `staging-e2e-signup-abuse-${Date.now().toString(36)}`
  const progress = (stage: string) => args.onProgress?.(stage)
  // One ledger per leg: it guards that every recorded label contains ITS run id,
  // and each leg's magic link is labelled with that leg's tag (see below).
  const exemptLedger = new StagingResourceLedger(runId)
  const convex = new ConvexHttpClient(env.convexUrl)
  const vmNames: string[] = []
  const artifacts = new StagingArtifactCollector(path.join(env.artifactRoot, runId), [
    env.internalKey,
    env.vercelBypassSecret,
  ])
  await artifacts.initialize()

  const inbox = await resolveAgentMailInbox({
    apiKey: env.agentMailApiKey,
    address: env.agentMailInboxAddress,
  })
  // The tag is both the exemption signal and the mailbox discriminator:
  // `findRunMessage` matches on the tag appearing in the message, and
  // `classifySignupIdentity` exempts only tags carrying the staging-e2e- marker.
  // So each leg's tag has to be the id we hand the mail matcher, not the
  // journey's runId — otherwise the refused leg waits forever for a message it
  // will never recognise.
  const exemptTag = runId
  const refusedTag = `abuse-${Date.now().toString(36)}`
  const refusedLedger = new StagingResourceLedger(refusedTag)
  const exemptEmail = taggedInboxAddress(inbox.address, exemptTag)
  // Same inbox, no synthetic marker — therefore not exempt, and deliverable.
  const refusedEmail = taggedInboxAddress(inbox.address, refusedTag)

  let browser: Browser | undefined
  let evidence: SignupAbuseEvidence | undefined
  let cleanup: StagingCleanupReport | undefined
  const contexts: BrowserContext[] = []
  // ONE CONTEXT PER LEG. Sharing one leaves the browser signed in from the first
  // leg, so the second never sees the sign-in form at all — the client notices
  // the existing session and posts straight to /api/duet/session. The second leg
  // has to be a genuinely cold browser or it is not testing a signup.
  const freshContext = async (): Promise<BrowserContext> => {
    const created = await (browser as Browser).newContext()
    await installStagingProtection(created, env)
    attachBrowserDiagnostics(created, artifacts)
    contexts.push(created)
    return created
  }
  try {
    browser = await chromium.launch({ headless: env.headless })

    progress('exempt-signup')
    const exemptReached = await signUpThroughBrowser({
      context: await freshContext(),
      env,
      convex,
      ledger: exemptLedger,
      vmNames,
      runId: exemptTag,
      email: exemptEmail,
      retireAccount: true,
      inboxId: inbox.id,
      progress: stage => progress(`exempt:${stage}`),
    })
    assert.equal(exemptReached.sessionStatus, 204, 'exempt signup was refused')

    progress('withheld-signup')
    // A non-exempt address on a blocklisted-by-MX-or-domain footing still signs
    // in — nothing is refused any more. What the gate takes away is the trial,
    // so the assertion is on the ledger and the withheld stamp, not on an HTTP
    // status. This also means the leg no longer depends on the deployed client
    // sending a device identification.
    const withheld = await signUpThroughBrowser({
      context: await freshContext(),
      env,
      convex,
      ledger: refusedLedger,
      vmNames,
      runId: refusedTag,
      email: refusedEmail,
      // Unmarked by design, so unrecognisable to the retire helper. The
      // born-disposable sweep reclaims this identity instead.
      retireAccount: false,
      inboxId: inbox.id,
      progress: stage => progress(`withheld:${stage}`),
    })
    assert.equal(withheld.sessionStatus, 204, 'the withheld signup did not complete')

    progress('ledger')
    const signal = await readSignupSignal(env, refusedEmail)
    assert(
      signal !== undefined,
      'the non-exempt signup kept its trial — the gate did not evaluate it',
    )

    evidence = {
      exempt: { email: exemptEmail, workspaceReached: true },
      withheld: { email: refusedEmail, reason: signal.reason },
    }
  } finally {
    progress('cleanup')
    for (const created of contexts) await created.close()
    await browser?.close()
    // In the finally, not the happy path: a run that dies on an assertion
    // created the same accounts and workspaces as one that passed, and used to
    // walk away from every one of them. Both legs are reclaimed here; the
    // ledgers are separate only because each guards that its labels carry its
    // own leg's tag.
    const [exemptCleanup, refusedCleanup] = [
      await exemptLedger.cleanupAll(),
      await refusedLedger.cleanupAll(),
    ]
    cleanup = {
      runId,
      status: exemptCleanup.status === 'pass' && refusedCleanup.status === 'pass' ? 'pass' : 'fail',
      resources: [...exemptCleanup.resources, ...refusedCleanup.resources],
      orphans: [...exemptCleanup.orphans, ...refusedCleanup.orphans],
    }
    await artifacts.flushDiagnostics()
  }

  assert(evidence !== undefined, 'journey completed without evidence')
  if (cleanup.status !== 'pass') {
    throw new Error(`journey cleanup failed: ${JSON.stringify(cleanup)}`)
  }
  return { evidence, vmNames, cleanup }
}

/**
 * Drives the real sign-in page end to end: enter the address, wait for the
 * magic link to arrive, follow it, and report what the session bootstrap said.
 */
async function signUpThroughBrowser(args: {
  context: BrowserContext
  env: ReturnType<typeof readLiveEnv>
  convex: ConvexHttpClient
  ledger: StagingResourceLedger
  vmNames: string[]
  runId: string
  email: string
  /**
   * Whether this leg's address carries the synthetic marker, and so whether
   * `retireUserByEmailForTest` will consent to erase the account it created.
   */
  retireAccount: boolean
  inboxId: string
  progress: (stage: string) => void
}): Promise<{ sessionStatus: number; sessionBody: string }> {
  const page = await args.context.newPage()

  args.progress('open-sign-in')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, new URL('/sign-in', args.env.appUrl).toString())

  const controls = await waitForHydratedMagicLinkControls(page)
  await controls.email.fill(args.email)
  const requestedAt = Date.now()
  const [intent] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/magic-link',
    ),
    controls.submit.click({ noWaitAfter: true }),
  ])
  assert.equal(intent.status(), 204, 'magic-link intent failed')

  args.progress('await-magic-link')
  const magicLink = await waitForBrowserMagicLink({
    env: args.env,
    page,
    ledger: args.ledger,
    email: args.email,
    inboxId: args.inboxId,
    requestedAt,
    runId: args.runId,
    returnTo: '/',
  })

  args.progress('await-session')
  // Bounded: a session POST that never happens is a real failure mode (the
  // client can error out before it fires), and waiting forever turns that into
  // an unattributable hang instead of an assertion with evidence.
  const sessionResponse = page
    .waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/duet/session',
      { timeout: 90_000 },
    )
    .catch(() => undefined)
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, magicLink)
  const session = await sessionResponse
  assert(
    session !== undefined,
    `the sign-in page never posted /api/duet/session for ${args.email} — it errored before reaching the gate`,
  )
  const sessionStatus = session.status()
  const sessionBody = sessionStatus === 204 ? '' : await session.text().catch(() => '')
  if (sessionStatus === 204) {
    await waitForBrowserSessionCredential({
      cookies: async () => await args.context.cookies(args.env.appUrl),
    })
    await recordSignupCleanup(args)
  }
  await page.close()
  return { sessionStatus, sessionBody }
}

/**
 * Registers what the signup just brought into existence, so the run reclaims it
 * instead of stranding it. A browser signup cannot ask to be ephemeral — there
 * is no such option on the sign-in page — so nothing here is implied by the act
 * of signing up; the resources have to be found after the fact and recorded.
 *
 * The account itself is only retired for the exempt leg: the deny leg's address
 * deliberately carries no synthetic marker, and `retireUserByEmailForTest`
 * refuses to erase anything it cannot recognise as ours. That leg is left to
 * the born-disposable expiry sweep, which needs no marker because it keys on
 * the inbox. Workspaces are recorded for BOTH legs regardless — the deny leg
 * gets none today (no trial, no workspace), and if that ever changes the VM is
 * reclaimed here rather than discovered as an orphan months later.
 */
async function recordSignupCleanup(args: {
  env: ReturnType<typeof readLiveEnv>
  convex: ConvexHttpClient
  ledger: StagingResourceLedger
  vmNames: string[]
  email: string
  retireAccount: boolean
}): Promise<void> {
  const email = args.email.trim().toLowerCase()
  // The raw read, not the stagingE2e one: that helper asserts a synthetic
  // address and the deny leg deliberately has none.
  const user = (await args.convex.query(fnQuery('testing/workspaces:rawUserByEmailForTest'), {
    internalKey: args.env.internalKey,
    email,
  })) as { _id: string; ephemeralExpiresAt?: number } | null
  assert(user !== null, `signup completed but no user exists for ${email}`)
  // The backstop, asserted where it actually has to hold. Cleanup below frees
  // the VM in minutes, but only this makes a run that dies before reaching it
  // — or a future journey nobody wired a ledger into — reclaim itself.
  assert(
    user.ephemeralExpiresAt !== undefined,
    `${email} was not born disposable: staging is not applying the test-inbox expiry`,
  )

  if (args.retireAccount) {
    args.ledger.record({
      kind: 'user',
      id: user._id,
      label: `${args.ledger.runId}:owner:${email}`,
      // Last: the workspaces have to go before their owner does.
      cleanupPriority: -100,
      cleanup: async () => {
        await args.convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
          internalKey: args.env.internalKey,
          email,
        })
      },
      verify: async () =>
        (await args.convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
          internalKey: args.env.internalKey,
          email,
        })) === null,
    })
  }

  const workspaces = (await args.convex.query(
    fnQuery('testing/workspaces:workspacesByOwnerForTest'),
    { internalKey: args.env.internalKey, userId: user._id },
  )) as Array<{ _id: string }>
  for (const workspace of workspaces) {
    // Let provisioning report a VM name before this workspace becomes
    // deletable. Teardown snapshots the identity it intends to remove, so
    // deleting a workspace that has not yet named its VM can leave that VM
    // running with nothing left pointing at it — the exact leak this journey
    // used to produce. A timeout here is tolerated rather than fatal: teardown
    // still falls back to the deterministic VM name, and a signup-gate journey
    // should not fail over slow provisioning.
    await waitForWorkspace(
      args.convex,
      args.env.internalKey,
      workspace._id,
      row => row.vmName !== undefined,
      180_000,
    ).catch(() => undefined)
    recordWorkspaceCleanup({
      ledger: args.ledger,
      convex: args.convex,
      env: args.env,
      output: { vmNames: args.vmNames },
      workspaceId: workspace._id,
      // The owner's address is the only handle the id-only listing gives us,
      // and it already carries this leg's tag — enough to read a label by.
      slug: email,
    })
  }
}

async function readSignupSignal(
  env: ReturnType<typeof readLiveEnv>,
  email: string,
): Promise<{ reason: string } | undefined> {
  const convex = new ConvexHttpClient(env.convexUrl)
  const rows = (await convex.query(fnQuery('testing/signupAbuse:signupSignalsForTest'), {
    internalKey: env.internalKey,
    email: email.trim().toLowerCase(),
  })) as { reason: string }[]
  return rows[0]
}
