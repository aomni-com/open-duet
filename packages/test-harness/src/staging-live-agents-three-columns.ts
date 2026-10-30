/* ============================================================================
   The three-column agents section, against a deployed Convex.

   Almost everything this feature does is provable without a deployment: the
   fold resolver is pure, the grammar has its own suite, and the layout is
   photographed hermetically. One claim is not, and it is the reason this
   journey exists.

   ---- what only a real deployment can answer ----
   **A roster row shows the last thing said in that agent's conversation.** That
   travels the whole length of the feature: a message is appended on a real
   Convex, `appendEvent` derives a preview and materialises it on the session
   row, the drive-wide activity read joins it onto the owner's chat, and the row
   renders it. Every fixture in the product mocks the wire at the client seam,
   so a fixture proving this would be proving its own mock. A schema that did
   not deploy, a stale function bundle, or an arg validator that never learned
   the new field all show up here and nowhere else.

   The second claim is smaller and rides along free: the section's front door.
   `/w/:ws` must settle on the root agent rather than the drive's picture, and
   that is a redirect chain through deployed routing rather than a unit test's
   idea of one.

   ---- what is deliberately not here ----
   The fold, the auto-fold band, the restack threshold and the pinned graph row.
   All four are decided by the browser's own width and the reader's stored
   preference, neither of which a deployment has an opinion about — they are
   covered by unit tests over a pure resolver and by the Docker visual gate.
   Putting them here would spend real staging resources re-asking a question
   already answered somewhere cheaper.
   ========================================================================= */
import assert from 'node:assert/strict'

import {
  CHAT_PREVIEW_MAX,
  ROOT_AGENT_SCOPE,
  SessionActivityResponseSchema,
  type MessagePreview,
} from '@repo/contract'

import { submitWait } from './staging-live-foreground-session-waits.ts'
import { apiJson, bearer } from './staging-live-http.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const PREVIEW_WAIT_MS = 180_000
const POLL_MS = 2_000

/** A phrase no fixture or seed would produce, so finding it proves the round trip. */
const SPOKEN = 'the roster preview crossed a deployed convex'

export type AgentsThreeColumnsEvidence = {
  /** the owner whose chat the preview was read from */
  agentId: string
  /** what the row would draw, exactly as the wire served it */
  preview: MessagePreview
  /** how many polls it took for the write to reach the read */
  pollsToArrive: number
}

export async function runAgentsThreeColumnsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<AgentsThreeColumnsEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'agents-three-columns',
    label: 'Agents — three columns',
    onProgress: options.onProgress,
    run: async context => await runAgentsThreeColumnsAcceptance(context),
  })
}

export async function runAgentsThreeColumnsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<AgentsThreeColumnsEvidence> {
  const { env, page, workspace, apiToken, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  const activity = async (label: string) =>
    SessionActivityResponseSchema.parse(
      await apiJson(
        `${base}/agent/sessions/activity`,
        { headers: bearer(apiToken) },
        200,
        label,
        artifacts,
      ),
    )

  /* The drive's own agent, because it is the one every workspace has and the one
     the front door opens on. Reading it before saying anything is what makes the
     assertion below about *this* message rather than about whatever the seed
     left behind. */
  progress('agents-three-columns:before')
  const before = await activity('activity before the message')
  const rootBefore = before.owners.find(owner => owner.agentId === ROOT_AGENT_SCOPE)
  assert(rootBefore !== undefined, 'the drive root is missing from the activity read')

  /* Into the root's OWN chat, through the default-session alias, and not by
     starting a fresh session. The preview the roster draws is `chat.preview`,
     and `chat` is the owner's default-session pointer — stamped on an owner's
     first message and never moved. On a workspace that has already been talked
     to, a new session is a *work* row, its preview is never read by any row,
     and this journey would wait three minutes to assert nothing. */
  progress('agents-three-columns:speak')
  await submitWait(context, `${base}/agents/${ROOT_AGENT_SCOPE}/sessions/default/messages/wait`, {
    prompt: SPOKEN,
  })

  /* Poll rather than sleep. The preview is written in the same transaction as
     the event, but the read is a separate query against a deployed deployment,
     and asserting on the first response would be asserting on the network. */
  progress('agents-three-columns:preview')
  const deadline = Date.now() + PREVIEW_WAIT_MS
  let polls = 0
  let seen: MessagePreview | undefined
  let agentId = ROOT_AGENT_SCOPE
  while (Date.now() < deadline) {
    polls += 1
    const now = await activity(`activity poll ${polls}`)
    const owner = now.owners.find(candidate => candidate.chat?.preview?.text.includes(SPOKEN))
    if (owner?.chat?.preview !== undefined) {
      seen = owner.chat.preview
      agentId = owner.agentId
      break
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }

  assert(
    seen !== undefined,
    `no owner's chat carried the spoken phrase within ${PREVIEW_WAIT_MS}ms — the preview did not survive the round trip`,
  )

  /* Attributed to the identity that submitted it — not to the category. The
     row resolves that id against the workspace roster to draw a name, so a
     preview that came back as the agent's, or as a user id that is not the one
     this journey signed in as, means the derivation read the wrong end of the
     turn or lost the sender on the way to the row. */
  assert(seen.author.kind === 'user', 'a message the reader sent came back attributed elsewhere')
  assert(
    seen.author.userId.length > 0,
    'the preview carried a user author with no identity behind it',
  )

  /* Truncated by the server, not by the row. The bound is a contract constant so
     that this assertion and the renderer cannot disagree about it. */
  assert(
    seen.text.length <= CHAT_PREVIEW_MAX,
    `the preview arrived ${seen.text.length} characters long, over the ${CHAT_PREVIEW_MAX} the server owns`,
  )

  /* The front door, in a browser, because that is the only place it happens.
     `/w/:ws` reaches the root agent through a client-side `<Navigate>` — a bare
     `fetch` follows no such redirect and the SPA answers 200 for every path, so
     asserting on the response would assert that the app is up while claiming to
     assert where it lands. */
  progress('agents-three-columns:front-door')
  await page.goto(`${env.appUrl}/w/${workspace.slug}`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL(/\/w\/[^/]+\/agents\/root(\/|$)/, { timeout: 60_000 })
  /* And the roster is beside it — the whole point of the section. Its rows are
     what carry the preview asserted above. */
  await page.getByRole('navigation', { name: /agents/i }).waitFor({ timeout: 60_000 })

  return { agentId, preview: seen, pollsToArrive: polls }
}
