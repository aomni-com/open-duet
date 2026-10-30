import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  AgentListResponseSchema,
  AgentRosterPageSchema,
  OpenOnboardingSessionResponseSchema,
  SessionInputResponseSchema,
  SessionSnapshotSchema,
  type Agent,
} from '@repo/contract'

import { markStagingAgentOnboarded, provisionStagingAgent } from './staging-live-agent-fixture.ts'
import { navigateDeployedPage } from './staging-live-browser.ts'
import { fnMutation, fnQuery } from './staging-live-env.ts'
import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { loadAllSessionListItems } from './staging-live-pagination.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const UNLOCK_WAIT_MS = 60_000
// Leg B waits on a real model turn — read two prompt layers, do the interview
// work, then call the endpoint — not on a state change the harness just caused.
// Budget for the SECOND turn: receive the answer, write the marker, then three
// shell round-trips to resolve slugs and POST. The one-turn version of this leg
// finished in ~254s, so 300s left no headroom once a real exchange was involved.
const SELF_COMPLETION_WAIT_MS = 420_000
// A ceiling on the opening turn, not a duration to wait out: the gate check
// returns the moment that turn stops. Must clear the gateway's own
// DEFAULT_TURN_STARTED_TIMEOUT_MS (600s) with room to spare, or this gate
// truncates the very wait it is measuring and the harness reports a stall the
// product never had. Leg B's turn also queues behind leg A's, and a run where
// leg A burned its ceiling and then succeeded on retry (301s + 138s) left
// nothing for leg B inside a 600s budget.
const AWAITING_USER_HOLD_MS = 600_000
const POLL_MS = 1_000

export interface AgentOnboardingEvidence {
  agentId: string
  agentSlug: string
  anchorPath: string
  onboardingSessionId: string
  reusedSessionId: string
  onboardedAt: number
  relockedAfterRedo: boolean
  selfCompletion: {
    agentId: string
    agentSlug: string
    sessionId: string
    onboardedAt: number
    interviewMarker: string
    codewordRecorded: boolean
  }
}

export async function runAgentOnboardingJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<AgentOnboardingEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'agent-onboarding',
    label: 'Agent Onboarding',
    onProgress: options.onProgress,
    run: async context => await runAgentOnboardingAcceptance(context),
  })
}

/**
 * Leg A of the agent-onboarding acceptance: the direct chat round-trip, proved
 * against deployed services and a real VM.
 *
 * Scope, stated because the gap between these two legs went unnoticed through
 * two green runs. Leg A owns everything the endpoint and the UI do — the
 * locked card, the open-or-create resolver, absence from every session list
 * while staying directly readable and attributed, the unlock, and redo — and
 * it drives the endpoint itself. It does not, and is not meant to, show that
 * an agent completes its own onboarding: `runSelfCompletionLeg` owns that and
 * nothing else does.
 *
 * The campaign leg (attribution → signup → auto-install → chained onboarding)
 * is deliberately absent: it needs a campaign that actually carries
 * `marketplace`, and that mapping is a product decision that retroactively
 * locks every installed copy of those agents in both environments. See
 * `specs/done/agent-onboarding/README.md`.
 */
export async function runAgentOnboardingAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<AgentOnboardingEvidence> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const suffix = runId.slice(-8).toLowerCase()
  const agentSlug = `onboard-${suffix}`
  const agentName = `Onboard ${suffix}`
  const anchorPath = `agents/${agentSlug}`
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  progress('agent-onboarding:provision-agent')
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: agentSlug,
    name: agentName,
    description: `Onboarding acceptance agent for ${runId}.`,
    ledger,
    convex,
    artifacts,
  })

  // The two files that make this a locked, chat-onboarding agent. `agent.json`
  // is ordinary synced drive content — writing it through the files API is
  // exactly how an author or the manage-agents skill would.
  progress('agent-onboarding:declare-onboarding')
  await apiText(
    `${base}/files/${anchorPath}/ONBOARDING.md`,
    {
      method: 'PUT',
      headers: bearer(apiToken, { 'content-type': 'text/markdown' }),
      body: `# Onboarding\n\nAsk the user for one preference, then finish.\nRun ${runId}.\n`,
    },
    200,
    'onboarding prompt write',
    artifacts,
  )
  await apiText(
    `${base}/files/${anchorPath}/agent.json`,
    {
      method: 'PUT',
      headers: bearer(apiToken, { 'content-type': 'application/json' }),
      body: `${JSON.stringify({ onboarding: { kind: 'chat' } }, null, 2)}\n`,
    },
    200,
    'agent config write',
    artifacts,
  )

  progress('agent-onboarding:locked-card')
  assert.equal(
    (await readAgent(base, apiToken, agent.id, artifacts)).onboardedAt,
    undefined,
    'a freshly declared onboarding agent must start un-onboarded',
  )
  /* The agent's OWN address, not the ring. A locked agent is drawn as a face
     like any other out there — the ring says nothing about setup and never did
     once the roster it replaced went away — so the surface this leg is about is
     the one you get by opening the agent.

     Looking at it IS the setup: a chat-onboarded agent opens its setup
     conversation on sight and gives it the whole card, so what proves the
     locked state here is the composer being there with nothing else around it
     — no second conversation panel beside it, no row of views above it. */
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/agents/${agentSlug}`)
  await page
    .locator('[data-session-surface="product"]')
    .first()
    .waitFor({ state: 'visible', timeout: UNLOCK_WAIT_MS })
  /* The withholding is half the claim, and the panel is what is withheld: the
     ordinary two-column surface keeps its conversation in `.km-chat`, and a
     locked agent has no ordinary conversation to hold.

     A count of zero would also be satisfied by the class simply being renamed,
     which is why the unlocked leg below WAITS for the same selector rather than
     asserting another absence — a rename fails there, loudly, before this one
     can go quietly green. Do not turn that one into an absence check too. */
  assert.equal(
    await page.locator('.km-chat').count(),
    0,
    'a locked agent still drew its ordinary conversation panel beside the setup',
  )
  await page.screenshot({
    path: path.join(artifacts.directory, 'agent-onboarding-locked.png'),
    fullPage: true,
  })

  /* Open-or-create, and the surface above has already called it once by being
     looked at. Every later call — a second visit, a reload, the API — must land
     in that same conversation rather than fork one, which is the whole reason
     the surface can open it on sight at all. */
  progress('agent-onboarding:open-session')
  const opened = await openOnboardingSession(base, apiToken, agentSlug, artifacts)
  const reopened = await openOnboardingSession(base, apiToken, agentSlug, artifacts)
  assert.equal(reopened, opened, 'reopening onboarding forked a second conversation')

  // Hidden everywhere a user could stumble on it, but still directly readable —
  // it is the session they are sitting in.
  progress('agent-onboarding:hidden-session')
  await assertHiddenFromLists(base, apiToken, opened, artifacts)
  const snapshot = SessionSnapshotSchema.parse(
    await apiJson(
      `${base}/agent/sessions/${opened}`,
      { headers: bearer(apiToken) },
      200,
      'onboarding session detail',
      artifacts,
    ),
  )
  assert.equal(snapshot.onboarding, true, 'the onboarding session lost its marker')
  assert.equal(snapshot.agent?.id, agent.id, 'the onboarding session was attributed elsewhere')

  // The harness makes this call, standing in for the agent, to isolate what
  // the endpoint itself does: unlock the card. That an agent makes this call
  // on its own is a different claim and is Leg B's, not this one's — reading
  // this step as covering it is what left the completion prompt unexercised
  // through two green runs.
  progress('agent-onboarding:mark-onboarded')
  await markStagingAgentOnboarded({ env, workspace, apiToken, slug: agentSlug, artifacts })
  await assertRosterLock(base, apiToken, agentSlug, false, artifacts)
  const onboarded = await waitForOnboardedAt(base, apiToken, agent.id, true, artifacts)
  assert.notEqual(onboarded, undefined, 'onboardedAt never landed')

  progress('agent-onboarding:unlocked-card')
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/agents/${agentSlug}`)
  /* Wait for the surface to PAINT before judging the absence of the CTA.
     Asserting `detached` on its own passes vacuously on a page that has not
     rendered yet — which is exactly what an early run captured: a loading
     skeleton that satisfied the assertion and screenshotted nothing. The
     conversation panel is the thing to wait for, because it is precisely what
     the locked surface withheld: it coming back IS the unlock. */
  await page.locator('.km-chat').first().waitFor({ state: 'visible', timeout: UNLOCK_WAIT_MS })
  await expectNoOnboardCta(page)
  await page.screenshot({
    path: path.join(artifacts.directory, 'agent-onboarding-unlocked.png'),
    fullPage: true,
  })

  // Redo is the same endpoint, and it must genuinely re-lock.
  progress('agent-onboarding:redo')
  await markStagingAgentOnboarded({
    env,
    workspace,
    apiToken,
    slug: agentSlug,
    onboarded: false,
    artifacts,
  })
  await assertRosterLock(base, apiToken, agentSlug, true, artifacts)
  const cleared = await waitForOnboardedAt(base, apiToken, agent.id, false, artifacts)
  assert.equal(cleared, undefined, 'redo did not clear onboarding completion')

  const selfCompletion = await runSelfCompletionLeg(context, suffix)

  return {
    agentId: agent.id,
    agentSlug,
    anchorPath,
    onboardingSessionId: opened,
    reusedSessionId: reopened,
    onboardedAt: onboarded!,
    relockedAfterRedo: true,
    selfCompletion,
  }
}

/**
 * The authored layer for Leg B, kept pure so its load-bearing properties can be
 * tested without staging.
 *
 * Two things it must never do. It must not mention the onboarded endpoint: if
 * it did, the agent could finish from this layer alone and the leg would pass
 * with the Duet-generated completion block missing entirely, which is the one
 * thing Leg B exists to detect. And it must not let the agent invent the
 * answer — the whole point is that onboarding blocks on a human.
 */
export function buildSelfCompletionInterview(args: { anchorPath: string; marker: string }): string {
  return [
    '# Onboarding',
    '',
    'Ask the user, in your first message, for their launch codeword.',
    '',
    'You cannot guess it, derive it, or proceed without it. If they have not',
    'told you the codeword yet, ask and then wait — do not act on anything else',
    'in this file until they answer.',
    '',
    'Once they give you the codeword, and only then:',
    '',
    `1. write it to \`${args.marker}\` in this agent's folder`,
    `   (\`${args.anchorPath}\`), on a line of its own, exactly as they typed it;`,
    '2. treat onboarding as finished.',
    '',
  ].join('\n')
}

/**
 * Leg B: the agent runs the interview and completes its own onboarding.
 *
 * This is the leg the harness stays out of. Leg A drives the onboarded
 * endpoint itself; here nothing but the agent ever calls it, so a pass means
 * the layered system prompt reached a real runner and was obeyed.
 *
 * It is a real conversation, because the degenerate version proves the wrong
 * thing. An interview the agent can satisfy alone never blocks on a human, so
 * it cannot show the guarantee that matters most in production: an agent must
 * NOT unlock itself before the user has supplied what was asked for. So the
 * codeword is unguessable and known only to this run, and the leg checks the
 * gate from both sides — still locked while the answer is outstanding, and
 * onboarded once it arrives, with that exact codeword recorded.
 *
 * It provisions its own agent, which looks like Leg A's setup repeated and is
 * not: opening an onboarding session is open-or-CREATE, so reusing Leg A's
 * agent would drop this leg into Leg A's existing conversation, complete with
 * the turns that already ran there. A virgin conversation is the subject.
 * Nothing else is re-tested — the card, the resolver, the list hiding, and redo
 * are Leg A's and are not touched again here.
 *
 * It also separates the two prompt layers, so a failure names the guilty one:
 *  - only the authored `ONBOARDING.md` names the marker file and asks for the
 *    codeword, so the marker cannot appear with the right contents unless that
 *    layer was read;
 *  - only the Duet-generated completion block names the endpoint, and the
 *    interview deliberately never mentions it.
 */
async function runSelfCompletionLeg(
  context: WorkspaceBrowserJourneyContext,
  suffix: string,
): Promise<AgentOnboardingEvidence['selfCompletion']> {
  const { env, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const agentSlug = `selfonb-${suffix}`
  const anchorPath = `agents/${agentSlug}`
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const marker = 'onboarding-answers.md'
  // Unguessable and unique to this run: the agent cannot produce it by
  // inference, so a marker containing it can only have come from the reply.
  const codeword = `heron-${suffix}-${Math.random().toString(36).slice(2, 8)}`

  progress('agent-onboarding:self-provision-agent')
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: agentSlug,
    name: `Self Onboard ${suffix}`,
    description: `Self-completing onboarding acceptance agent for ${runId}.`,
    ledger,
    convex,
    artifacts,
  })

  // Deliberately silent about the onboarded endpoint: if this file mentioned
  // it, a pass would not tell us whether the completion layer arrived.
  progress('agent-onboarding:self-declare')
  await apiText(
    `${base}/files/${anchorPath}/ONBOARDING.md`,
    {
      method: 'PUT',
      headers: bearer(apiToken, { 'content-type': 'text/markdown' }),
      body: buildSelfCompletionInterview({ anchorPath, marker }),
    },
    200,
    'self-completion onboarding prompt write',
    artifacts,
  )
  await apiText(
    `${base}/files/${anchorPath}/agent.json`,
    {
      method: 'PUT',
      headers: bearer(apiToken, { 'content-type': 'application/json' }),
      body: `${JSON.stringify({ onboarding: { kind: 'chat' } }, null, 2)}\n`,
    },
    200,
    'self-completion agent config write',
    artifacts,
  )
  // No "starts un-onboarded" assertion here: Leg A already proves a freshly
  // declared onboarding agent does, and the gate check below re-reads it on
  // every poll anyway. Live minutes are the scarce resource in this journey.

  // All the harness does on its own behalf: press the button a user presses.
  progress('agent-onboarding:self-open-session')
  const sessionId = await openOnboardingSession(base, apiToken, agentSlug, artifacts)

  // Everything from here can fail, and every one of those failures is about
  // what the agent did — which is gone the moment the journey tears its
  // workspace down. Capture first, then rethrow.
  try {
    return await runInterview()
  } catch (error) {
    await captureOnboardingTranscript(
      env,
      workspace.slug,
      apiToken,
      sessionId,
      artifacts,
      workspace._id,
      context.ledger,
      context.convex,
      runId,
    )
    throw error
  }

  async function runInterview(): Promise<AgentOnboardingEvidence['selfCompletion']> {
    // The gate, from the side that actually protects users. The agent has been
    // told to finish, and cannot: it is missing something only a human has. An
    // agent that unlocks here has handed the user a configured-looking agent
    // that was never configured.
    progress('agent-onboarding:self-awaits-user')
    await assertHeldForUser(env, workspace.slug, base, apiToken, agent.id, sessionId, artifacts)

    progress('agent-onboarding:self-answer')
    const answered = SessionInputResponseSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({
            behavior: 'steer',
            prompt: `My launch codeword is ${codeword}`,
          }),
        },
        202,
        'self-completion user answer',
        artifacts,
      ),
    )
    // Both dispositions are correct and which one you get is a race: `accepted`
    // if the runner is idle waiting on the reply, `queued` if it is still mid-turn
    // asking the question. Demanding `accepted` failed a live run against
    // perfectly good behavior. What must hold is that the answer was taken.
    assert(
      answered.delivery === 'accepted' || answered.delivery === 'queued',
      `the onboarding runner refused the user answer: ${answered.delivery}`,
    )

    progress('agent-onboarding:self-complete')
    const onboardedAt = await waitForOnboardedAt(
      base,
      apiToken,
      agent.id,
      true,
      artifacts,
      SELF_COMPLETION_WAIT_MS,
    )
    assert.notEqual(
      onboardedAt,
      undefined,
      'the agent never marked itself onboarded after the user answered — the completion prompt layer did not reach the runner, or was not obeyed',
    )

    // Proves it onboarded on the strength of the answer rather than to get the
    // turn over with. Only the authored layer asked for this file.
    const written = await apiText(
      `${base}/files/${anchorPath}/${marker}`,
      { headers: bearer(apiToken) },
      200,
      'self-completion interview marker read',
      artifacts,
    )
    assert(
      written.includes(codeword),
      `the agent onboarded without recording the user's answer: ${marker} lacks ${codeword}`,
    )

    return {
      agentId: agent.id,
      agentSlug,
      sessionId,
      onboardedAt: onboardedAt!,
      interviewMarker: marker,
      codewordRecorded: true,
    }
  }
}

/**
 * Best-effort: a diagnostic must never mask the failure it is explaining.
 *
 * Captures both sides. The session history says what the product recorded; the
 * VM's own gateway and agent logs say what actually happened, and without them
 * a stalled turn is indistinguishable from a slow one — which is exactly the
 * hole that cost this feature seven blind staging runs.
 */
async function captureOnboardingTranscript(
  env: WorkspaceBrowserJourneyContext['env'],
  workspaceSlug: string,
  apiToken: string,
  sessionId: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
  workspaceId: string | undefined,
  ledger: WorkspaceBrowserJourneyContext['ledger'],
  convex: WorkspaceBrowserJourneyContext['convex'],
  runId: string,
): Promise<void> {
  try {
    const [history, snapshot] = await Promise.all([
      apiText(
        `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}/history`,
        { headers: bearer(apiToken) },
        200,
        'self-completion transcript capture',
        artifacts,
      ),
      // The snapshot carries `deliveryAttempt` — whether the control plane ever
      // handed this turn to a runner. A transcript holding only the kickoff
      // cannot distinguish "the runner never got it" from "the runner got it
      // and produced nothing", and those have different owners.
      apiText(
        `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}`,
        { headers: bearer(apiToken) },
        200,
        'self-completion snapshot capture',
        artifacts,
      ),
    ])
    await writeFile(
      path.join(artifacts.directory, 'self-completion-transcript.json'),
      JSON.stringify({ history: JSON.parse(history), snapshot: JSON.parse(snapshot) }, null, 2),
      'utf8',
    )
    if (workspaceId !== undefined) {
      await captureVmLogs(env, workspaceId, artifacts, ledger, convex, runId)
    }
  } catch (error) {
    // The failure that sent us here is still the real result, so this must not
    // throw — but it must not vanish either. A diagnostic that fails silently
    // is worse than none: it looks like it ran and reported nothing.
    await writeFile(
      path.join(artifacts.directory, 'self-completion-capture-error.txt'),
      `${String(error)}\n${error instanceof Error ? (error.stack ?? '') : ''}`,
      'utf8',
    ).catch(() => undefined)
    console.error(`STAGING_LIVE_CAPTURE_FAILED ${String(error)}`)
  }
}

/**
 * Pulls the VM's own logs through the operator endpoint, which is the only way
 * to read them: the drive-scoped file route cannot reach the state dir.
 * Requires an internal-admin identity, which the harness can mint because it
 * holds the programmatic login secret.
 */
async function captureVmLogs(
  env: WorkspaceBrowserJourneyContext['env'],
  workspaceId: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
  ledger: WorkspaceBrowserJourneyContext['ledger'],
  convex: WorkspaceBrowserJourneyContext['convex'],
  runId: string,
): Promise<void> {
  // Scoped to this run, not Date.now(): the ledger requires every label it
  // records to contain the run id (staging-live-resource-ledger.ts), which a
  // bare timestamp doesn't satisfy — this broke on the very first real run
  // after being added. Run-scoping also makes the leaked-account problem this
  // fix closes attributable to which run created it, not just a raw epoch.
  const adminEmail = `${runId}-onboarding-diagnostics@duet.so`
  const admin = (await apiJson(
    `${env.apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: bearerJson(env.loginSecret),
      body: JSON.stringify({
        email: adminEmail,
        create: true,
        ephemeral: true,
        name: 'Onboarding Diagnostics',
        ttlSeconds: 900,
      }),
    },
    200,
    'diagnostic admin login',
    artifacts,
  )) as { token: string }
  // Every other identity this journey creates is cleaned up the same way;
  // this one was missed when the diagnostic path was added mid-chase, and
  // every failed run left a permanent admin-capable account behind.
  ledger.record({
    kind: 'user',
    id: adminEmail,
    label: `${runId}:onboarding-diagnostics:${adminEmail}`,
    cleanupPriority: -100,
    cleanup: async () => {
      await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: env.internalKey,
        email: adminEmail,
      })
    },
    verify: async () =>
      (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: env.internalKey,
        email: adminEmail,
      })) === null,
  })

  // Every read is independently fault-tolerant and records its own status. One
  // unavailable source must not cost the others: a run that returns the gateway
  // log and an error for the agent log is far more useful than an exception.
  const read = async (query: string): Promise<unknown> => {
    const url = `${env.apiUrl}/v1/internal-admin/workspaces/${workspaceId}/logs?${query}`
    try {
      const response = await fetch(url, { headers: bearer(admin.token) })
      const body = await response.text()
      if (response.status !== 200)
        return { query, status: response.status, body: body.slice(0, 2_000) }
      return { query, status: 200, log: JSON.parse(body) }
    } catch (error) {
      return { query, error: String(error) }
    }
  }

  const gateway = (await read('source=gateway')) as {
    log?: { available?: Array<{ anchorId?: string }> }
  }
  const anchors = (gateway.log?.available ?? []).flatMap(entry =>
    entry.anchorId === undefined ? [] : [entry.anchorId],
  )
  const agents = await Promise.all(
    anchors.map(
      async anchorId => await read(`source=agent&anchorId=${encodeURIComponent(anchorId)}`),
    ),
  )
  await writeFile(
    path.join(artifacts.directory, 'self-completion-vm-logs.json'),
    JSON.stringify({ gateway, rootAgent: await read('source=agent'), agents }, null, 2),
    'utf8',
  )
}

/**
 * The gate must be observed HELD, not merely un-crossed at one instant:
 * `onboardedAt` is trivially absent before the runner has even started, so a
 * single read would pass on an agent that unlocks a second later.
 *
 * Waiting a fixed span would work and waste live minutes on every green run.
 * Instead this runs until the agent's first turn stops — the moment it has said
 * its piece and is waiting on the human — re-reading the lock the whole way. So
 * it ends as soon as there is something real to conclude, and concludes more:
 * not "the timeout elapsed" but "the agent finished a turn and did not unlock."
 */
async function assertHeldForUser(
  env: WorkspaceBrowserJourneyContext['env'],
  workspaceSlug: string,
  base: string,
  apiToken: string,
  agentId: string,
  sessionId: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<void> {
  const deadline = Date.now() + AWAITING_USER_HOLD_MS
  // Reported on timeout so a red run distinguishes "the turn is slow" from
  // "this field never leaves `running` for this session shape" — the second is
  // a broken gate, not a broken product, and they look identical otherwise.
  const observed = new Set<string>()
  for (;;) {
    const agent = await readAgent(base, apiToken, agentId, artifacts)
    assert.equal(
      agent.onboardedAt,
      undefined,
      'the agent onboarded itself before the user supplied anything',
    )
    const snapshot = SessionSnapshotSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}`,
        { headers: bearer(apiToken) },
        200,
        'onboarding turn activity',
        artifacts,
      ),
    )
    // `status` is on every session; `machine` is not — it only exists for
    // state-machine sessions, and an onboarding launch deliberately runs
    // without a forced mode, so keying this on machine would wait out the
    // whole ceiling and then fail every green run.
    observed.add(snapshot.turnStatus)
    if (snapshot.turnStatus !== 'running') return
    assert(
      Date.now() < deadline,
      `the onboarding agent never finished its opening turn, so the gate was never observed held (statuses seen: ${[...observed].join(', ')})`,
    )
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

// A positive wait first, then the negative check: the roster is painted, and
// within it this agent no longer offers onboarding.
async function expectNoOnboardCta(page: WorkspaceBrowserJourneyContext['page']): Promise<void> {
  assert.equal(
    await page.getByRole('button', { name: /onboard agent/i }).count(),
    0,
    'the onboarding CTA survived completion',
  )
}

async function openOnboardingSession(
  base: string,
  apiToken: string,
  agentSlug: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<string> {
  const opened = OpenOnboardingSessionResponseSchema.parse(
    await apiJson(
      `${base}/agents/${agentSlug}/onboarding-session`,
      { method: 'POST', headers: bearerJson(apiToken) },
      200,
      'open onboarding session',
      artifacts,
    ),
  )
  return opened.sessionId
}

async function assertHiddenFromLists(
  base: string,
  apiToken: string,
  sessionId: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<void> {
  for (const [label, query] of [
    ['unscoped', ''],
    ['archived', '?archived=only'],
    ['searched', '?search=onboarding'],
  ] as const) {
    const listed = await loadAllSessionListItems(
      `${base}/agent/sessions${query}`,
      apiToken,
      `onboarding hidden from ${label} sessions`,
      artifacts,
    )
    assert.equal(
      listed.some(session => session.id === sessionId),
      false,
      `the onboarding session appeared in the ${label} session list`,
    )
  }
}

async function readAgent(
  base: string,
  apiToken: string,
  agentId: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<Agent> {
  const listed = AgentListResponseSchema.parse(
    await apiJson(`${base}/agents`, { headers: bearer(apiToken) }, 200, 'list agents', artifacts),
  )
  const agent = listed.items.find(candidate => candidate.id === agentId)
  assert(agent !== undefined, 'the acceptance agent disappeared from the roster')
  return agent
}

async function waitForOnboardedAt(
  base: string,
  apiToken: string,
  agentId: string,
  expectSet: boolean,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
  timeoutMs: number = UNLOCK_WAIT_MS,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const agent = await readAgent(base, apiToken, agentId, artifacts)
    if ((agent.onboardedAt !== undefined) === expectSet) return agent.onboardedAt
    assert(Date.now() < deadline, `onboardedAt never became ${expectSet ? 'set' : 'clear'}`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

/** A cold VM may outlive the best-effort response deadline, but never wait for the idle poll. */
async function assertRosterLock(
  base: string,
  apiToken: string,
  slug: string,
  locked: boolean,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + 10_000
  for (;;) {
    const response = await stagingFetch(`${base}/agents/${slug}/roster?limit=100`, {
      headers: bearer(apiToken),
    })
    assert([200, 404, 503].includes(response.status), `roster read failed: ${response.status}`)
    if (response.ok) {
      const roster = AgentRosterPageSchema.parse(await response.json())
      if (roster.items.find(row => row.slug === slug)?.locked === locked) {
        assert(Date.now() < deadline, 'the gateway roster refresh exceeded 10 seconds')
        await writeFile(
          path.join(artifacts.directory, `roster-${slug}-${locked ? 'locked' : 'unlocked'}.json`),
          JSON.stringify({ locked, observedAfterMs: Date.now() - startedAt, roster }, null, 2),
        )
        return
      }
    } else {
      await response.body?.cancel()
    }
    assert(Date.now() < deadline, 'the gateway roster did not reflect onboarding within 10 seconds')
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}
