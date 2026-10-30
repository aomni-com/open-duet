import assert from 'node:assert/strict'

import type { ConvexHttpClient } from 'convex/browser'

import {
  AgentListResponseSchema,
  DeleteAgentResponseSchema,
  isKnownTimelineEvent,
  SessionCreateResponseSchema,
  SessionSnapshotSchema,
  type Agent,
  type SessionListItem,
  type SessionSnapshot,
} from '@repo/contract'
import { ExeClient } from '@repo/exe'

import { provisionStagingAgent, type StagingAgentFixtureEnv } from './staging-live-agent-fixture.ts'
import { deleteStagingSession, type JobPhase } from './staging-live-agent-sessions.ts'
import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import type { Workspace } from './staging-live-env.ts'
import { apiJson, apiText, bearer, bearerJson, timedFetch } from './staging-live-http.ts'
import {
  loadAllSessionListItems,
  loadChronologicalSessionHistory,
  type ChronologicalSessionHistory,
} from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import type { StagingResourceLedger } from './staging-live-resource-ledger.ts'

const SESSION_WAIT_MS = 240_000
const POLL_MS = 500
// Long enough that the runner stays busy on the VM across register → attribute →
// jobs → delete; short enough to matter nowhere, because deletion kills it first.
const HOLD_SLEEP_SECONDS = 600
const HOLD_STATE = 'hold_running_for_delete'
const DONE_STATE = 'lifecycle_completed'
const AGENT_DELETED_REASON = 'agent_deleted'
// Bounded window for the VM process to be reaped after the gateway's SIGKILL.
const RUNNER_ABSENCE_WAIT_MS = 15_000
// The e2e:staging container has no exe/SSH reachability; bound the probe so a
// keyless environment records 'unreachable' fast instead of hanging.
const EXE_PROBE_TIMEOUT_MS = 20_000

export interface AgentLifecycleEvidence {
  agentId: string
  agentSlug: string
  sessionId: string
  anchorPath: string
  /** The app registered inside the agent's folder, whose row the delete cascade must take with it. */
  appSlug: string
  /** 'gone' once the VM process is confirmed absent; 'unreachable' when exe/SSH is not reachable. */
  vmRunnerProbe: 'gone' | 'unreachable'
  /**
   * What the pre-delete process probe saw. 'parked' is not a failure: a long
   * `sleep` script state may hold no live runner process — sessions are
   * durable, and the API-level running-hold-task proof is the behavioral
   * contract. Recorded so a run shows which teardown path the delete proved.
   */
  vmRunnerBeforeDelete: 'present' | 'parked' | 'unreachable'
}

// Mirrors the agent-continuity control seam: the runner must issue exactly this
// tool call so the session parks in a running `script` hold state that stays
// active until the agent is deleted. Whether that hold keeps a live runner
// process on the VM or parks durably is the runner's business — the harness
// asserts the running task through the API, not the process table.
export function buildRunningAgentPrompt(token: string): string {
  const toolArguments = {
    definition: {
      name: `Live lifecycle ${token}`,
      prompt: [
        `This machine holds a running task for ${token}.`,
        `Stay in ${HOLD_STATE} until interrupted; only then select ${DONE_STATE}.`,
      ].join(' '),
      states: [
        { name: HOLD_STATE, kind: 'script', command: `sleep ${HOLD_SLEEP_SECONDS}` },
        { name: DONE_STATE, kind: 'terminal', status: 'completed' },
      ],
    },
    firstState: HOLD_STATE,
  }

  return [
    `Create the running task for "${token}" by calling create_state_machine_definition with exactly these arguments:`,
    JSON.stringify(toolArguments),
    'Do not use todo_write and do not answer normally instead of making the tool call.',
    'Once the tool accepts the definition, stop this turn so the running task holds open.',
  ].join(' ')
}

export function agentCardInRoster(agents: readonly Agent[], slug: string): Agent | undefined {
  return agents.find(agent => agent.slug === slug)
}

export function attributionMatchesAgent(
  row: Pick<SessionListItem, 'agent'>,
  agentId: string,
): boolean {
  return (
    row.agent?.id === agentId && typeof row.agent?.name === 'string' && row.agent.name.length > 0
  )
}

export function interruptedByAgentDeletion(history: ChronologicalSessionHistory): boolean {
  return history.events.some(
    row =>
      row.event.type === 'interrupted' &&
      'error' in row.event &&
      row.event.error === AGENT_DELETED_REASON,
  )
}

export function findRunningHoldTask(
  history: ChronologicalSessionHistory,
): { taskId: string; seq: number } | undefined {
  const started = history.events.find(
    row =>
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'task_started' &&
      row.event.task.name === HOLD_STATE &&
      row.event.task.status === 'running',
  )
  if (started === undefined) return undefined
  if (!isKnownTimelineEvent(started.event) || started.event.type !== 'task_started') {
    return undefined
  }
  const taskId = started.event.task.id
  const settled = history.events.some(
    row =>
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'task_settled' &&
      row.event.settlement.id === taskId,
  )
  return settled ? undefined : { taskId, seq: started.seq }
}

export function runnerProcessPresent(pgrepStdout: string, sessionId: string): boolean {
  return pgrepStdout.split('\n').some(line => line.includes(sessionId))
}

export async function runAgentLifecycleAcceptance(args: {
  env: StagingAgentFixtureEnv
  login: { token: string }
  workspace: Workspace
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress: (stage: string) => void
}): Promise<AgentLifecycleEvidence> {
  const { env, login, workspace, runId, ledger, convex, artifacts, progress } = args
  const slug = `e2e-agent-${runId.slice(-8)}`
  const anchorPath = `agents/${slug}`
  const agentName = `E2E Agent ${runId.slice(-8)}`
  const token = `agent-lifecycle-${runId}`
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  // Leg 1 — register an agent through the API (mkdir + AGENTS.md via the drive
  // API, then POST /agents), mirroring manage-agents' create flow.
  progress('agent-lifecycle:register')
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken: login.token,
    runId,
    slug,
    name: agentName,
    description: `Staging e2e lifecycle agent for ${runId}.`,
    ledger,
    convex,
    artifacts,
  })
  assert.equal(agent.slug, slug, 'registered agent slug did not round-trip')
  assert.equal(agent.name, agentName, 'registered agent name did not round-trip')

  // Leg 1b — an app INSIDE the agent's folder. Firing an agent deletes the
  // folder, and everything the folder held has to go with it; without a
  // descendant registered here the delete leg below proves only that the agent
  // row disappeared, which is exactly the half that already worked while apps
  // were left behind as unrepairable "folder link needs repair" phantoms.
  //
  // Declared through the agent, not as a standalone app: an agent's apps are
  // registered WITH the agent, atomically, which is the only path that creates
  // the app rows inside an agent folder the way the product does.
  progress('agent-lifecycle:register-app')
  const appSlug = `${slug}-board`
  const appPath = `${anchorPath}/apps/board`
  await apiJson(
    `${base}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(login.token),
      body: JSON.stringify({ operation: 'mkdir', path: appPath, recursive: true }),
    },
    200,
    'agent lifecycle app mkdir',
    artifacts,
  )
  // A real server, because registration does not return until the app is
  // actually running: `settleAppRegistrations` waits for it to bind. It only has
  // to answer on $PORT — the port the supervisor assigns, never a hardcoded one.
  await apiText(
    `${base}/files/${appPath}/server.ts`,
    {
      method: 'PUT',
      headers: bearer(login.token, { 'content-type': 'text/plain' }),
      body: [
        'const port = Number(process.env.PORT ?? 0)',
        "Bun.serve({ port, fetch: () => new Response('ok') })",
        '',
      ].join('\n'),
    },
    200,
    'agent lifecycle app server write',
    artifacts,
  )
  const withApp = (await apiJson(
    `${base}/agents`,
    {
      method: 'POST',
      headers: bearerJson(login.token),
      body: JSON.stringify({
        path: anchorPath,
        slug,
        name: agentName,
        apps: [
          {
            path: appPath,
            slug: appSlug,
            command: 'bun run server.ts',
            apiScopes: [],
          },
        ],
      }),
    },
    201,
    'agent lifecycle app register',
    artifacts,
  )) as { apps?: Array<{ slug: string; status: string }> }
  assert(
    withApp.apps?.some(app => app.slug === appSlug),
    'registering the agent with its app did not report the app back',
  )

  // Leg 2 — see its card in the roster. The harness journeys are API-level (like
  // agent-continuity), so this asserts the agent-list contract the roster UI
  // renders from rather than driving the shell.
  progress('agent-lifecycle:roster')
  const roster = AgentListResponseSchema.parse(
    await apiJson(
      `${base}/agents`,
      { headers: bearer(login.token) },
      200,
      'agent lifecycle roster',
      artifacts,
    ),
  )
  const card = agentCardInRoster(roster.items, slug)
  assert(card !== undefined, 'registered agent did not appear in the roster list')
  assert.equal(card.id, agent.id, 'roster card id did not match the registered agent')
  assert.equal(
    card.anchorPath,
    anchorPath,
    'roster card anchor path did not match the registered path',
  )

  // Leg 3 — start a session attributed to the agent by anchoring its cwd inside
  // the agent's folder, and confirm attribution + a live runner.
  progress('agent-lifecycle:session')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ prompt: buildRunningAgentPrompt(token), cwd: anchorPath }),
      },
      201,
      'agent lifecycle session create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  assert.equal(created.snapshot.cwd, anchorPath, 'session create did not carry the requested cwd')
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:agent-lifecycle-session:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, login.token),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })

  const attributed = await waitForSnapshot(base, sessionId, login.token, snapshot =>
    attributionMatchesAgent(snapshot, agent.id),
  )
  assert(
    attributionMatchesAgent(attributed, agent.id),
    'session cwd did not attribute the session to the agent',
  )
  assert.equal(attributed.agent?.id, agent.id, 'attributed agent id mismatch')

  // The live runner is proven by a running hold task — the same signal the VM
  // probe (below) confirms as a real process.
  await waitForHistory(
    base,
    sessionId,
    login.token,
    history => findRunningHoldTask(history) !== undefined,
    SESSION_WAIT_MS,
  )

  // Leg 4 — confirm attribution in Jobs (scoped list + chip data present) and in
  // the session rail (agent-scoped session list).
  progress('agent-lifecycle:jobs')
  const activeJob = await waitForJob(base, login.token, 'unfinished', agent.id, sessionId)
  assert(
    attributionMatchesAgent(activeJob, agent.id),
    'active job did not carry the agent attribution chip',
  )
  // The hold session is a script state machine. There is no longer a second list
  // that hides it — one list holds conversations and machine-backed jobs alike —
  // but the proof still wants a plain session under the same agent cwd, because
  // "a conversation is attributed too" is a different claim from "a job is".
  const railSession = SessionCreateResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ prompt: 'Reply with the single word: ready.', cwd: anchorPath }),
      },
      201,
      'agent lifecycle rail session create',
      artifacts,
    ),
  )
  const railSessionId = railSession.session.sessionId
  ledger.record({
    kind: 'session',
    id: railSessionId,
    label: `${runId}:agent-lifecycle-rail-session:${railSessionId}`,
    cleanup: async () =>
      await deleteStagingSession(env, workspace.slug, railSessionId, login.token),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  const railDeadline = Date.now() + SESSION_WAIT_MS
  let railList: SessionListItem[]
  for (;;) {
    railList = await loadAllSessionListItems(
      `${base}/agent/sessions?agentId=${agent.id}`,
      login.token,
      'agent lifecycle agent-scoped session list',
      artifacts,
    )
    if (railList.some(row => row.id === railSessionId)) break
    if (Date.now() >= railDeadline) {
      throw new Error('agent-scoped rail list did not surface the plain session')
    }
    await Bun.sleep(POLL_MS)
  }
  const railRow = railList.find(row => row.id === railSessionId)
  assert(railRow !== undefined, 'plain session missing from the agent-scoped rail list')
  assert(attributionMatchesAgent(railRow, agent.id), 'rail row did not carry the agent attribution')
  /* Inverted, and this is the product change. The rail used to filter
     `jobView === undefined`, so a session running a state machine was
     structurally absent from it — the user's list of their own work silently
     omitted the work that was actually running. One list now, so the job is
     expected *here*, beside the conversation. */
  assert(
    railList.some(row => row.id === sessionId),
    'the running job-session is missing from the agent-scoped list it belongs in',
  )

  // Runner-death is proven on the VM itself. There is no in-band per-session
  // runner-liveness endpoint (the internal-admin VM status only reports the
  // gateway process, and the gateway /command allowlist cannot enumerate
  // processes), so the only true VM observation is an SSH-exec `pgrep` for the
  // runner's `--session <id>` process, reachability-gated on exe.
  //
  // Presence before delete is recorded, never asserted: sessions are durable,
  // so a session parked in a long `sleep` script state may legitimately hold no
  // live runner process — the API-level running-hold-task proof above is the
  // behavioral contract. The hard VM assertion is absence AFTER delete, which
  // holds on both teardown paths (kill a live runner, or tombstone a parked
  // one so it can never wake).
  const sshDest = await resolveVmSshDest(workspace.vmName)
  let vmRunnerBeforeDelete: AgentLifecycleEvidence['vmRunnerBeforeDelete'] = 'unreachable'
  if (sshDest !== null) {
    const before = await probeRunner(sshDest, sessionId)
    vmRunnerBeforeDelete = runnerProcessPresent(before, sessionId) ? 'present' : 'parked'
  }

  // Leg 5 — delete the agent WHILE its session runs. The route is gateway-first
  // and fail-closed: a 200 means the gateway's discardAgent leg (runner kill +
  // tombstone) executed before the control-plane deletion.
  progress('agent-lifecycle:delete')
  DeleteAgentResponseSchema.parse(
    await apiJson(
      `${base}/agents/${slug}`,
      { method: 'DELETE', headers: bearer(login.token) },
      200,
      'agent lifecycle delete',
      artifacts,
    ),
  )

  progress('agent-lifecycle:converge')
  // Session converges to interrupted with the agent_deleted reason.
  await waitForSnapshot(
    base,
    sessionId,
    login.token,
    snapshot => snapshot.turnStatus === 'interrupted',
  )
  const terminalHistory = await waitForHistory(
    base,
    sessionId,
    login.token,
    interruptedByAgentDeletion,
    SESSION_WAIT_MS,
  )
  assert(
    interruptedByAgentDeletion(terminalHistory),
    'deleted agent did not terminalize its session with error:agent_deleted',
  )

  // No active job survives; the job moved to history with its attribution intact.
  await waitForNoActiveJob(base, login.token, agent.id, sessionId)
  const historyJob = await waitForJob(base, login.token, 'finished', agent.id, sessionId)
  assert(
    attributionMatchesAgent(historyJob, agent.id),
    'history job lost the agent attribution chip after delete',
  )
  // `jobView` is gone; `bucket` is the one axis, and `done` is what it said.
  assert.equal(historyJob.bucket, 'done', 'terminalized job did not bucket as done')

  // Attribution is immutable: still readable after the agent row is gone.
  const afterDelete = SessionSnapshotSchema.parse(
    await apiJson(
      `${base}/agent/sessions/${sessionId}`,
      { headers: bearer(login.token) },
      200,
      'agent lifecycle post-delete snapshot',
      artifacts,
    ),
  )
  assert(
    attributionMatchesAgent(afterDelete, agent.id),
    'attribution was not readable on the session after the agent was deleted',
  )

  // No ghost card: the deleted agent is gone from the roster.
  const rosterAfter = AgentListResponseSchema.parse(
    await apiJson(
      `${base}/agents`,
      { headers: bearer(login.token) },
      200,
      'agent lifecycle roster after delete',
      artifacts,
    ),
  )
  assert.equal(
    agentCardInRoster(rosterAfter.items, slug),
    undefined,
    'deleted agent still renders a ghost card in the roster',
  )

  // The filesystem is the source of truth, so firing the agent has to have taken
  // its folder — and with the folder gone, the app row inside it too. These two
  // are the live proof of the cascade: a control-plane-only delete leaves the app
  // registered against a folder that no longer exists, which is precisely the
  // state that used to strand apps in "folder link needs repair" forever.
  progress('agent-lifecycle:cascade-probe')
  const [missingApp, missingFolder] = await Promise.all([
    timedFetch(`${base}/apps/${appSlug}`, { headers: bearer(login.token) }, artifacts),
    timedFetch(`${base}/files/${anchorPath}?stat=1`, { headers: bearer(login.token) }, artifacts),
  ])
  assert.equal(
    missingApp.status,
    404,
    'firing the agent left its app registered against a folder it just deleted',
  )
  assert.equal(missingFolder.status, 404, 'firing the agent left its folder on the drive')

  // The VM assertion that catches a control-plane-only teardown: the runner
  // process is actually gone on the VM, not merely marked interrupted.
  let vmRunnerProbe: AgentLifecycleEvidence['vmRunnerProbe'] = 'unreachable'
  if (sshDest !== null) {
    progress('agent-lifecycle:vm-probe')
    const gone = await waitForRunnerAbsent(sshDest, sessionId)
    assert(
      gone,
      'runner process is still alive on the VM after agent delete — control-plane-only teardown',
    )
    vmRunnerProbe = 'gone'
  }

  return {
    agentId: agent.id,
    agentSlug: slug,
    sessionId,
    anchorPath,
    appSlug,
    vmRunnerProbe,
    vmRunnerBeforeDelete,
  }
}

async function waitForSnapshot(
  base: string,
  sessionId: string,
  token: string,
  predicate: (snapshot: SessionSnapshot) => boolean,
): Promise<SessionSnapshot> {
  const deadline = Date.now() + SESSION_WAIT_MS
  let latest: SessionSnapshot | undefined
  for (;;) {
    latest = SessionSnapshotSchema.parse(
      await apiJson(
        `${base}/agent/sessions/${sessionId}`,
        { headers: bearer(token) },
        200,
        'agent lifecycle session snapshot',
      ),
    )
    if (predicate(latest)) return latest
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for agent lifecycle snapshot: ${JSON.stringify({
          status: latest.turnStatus,
          agent: latest.agent,
        })}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

async function loadHistory(
  base: string,
  sessionId: string,
  token: string,
): Promise<ChronologicalSessionHistory> {
  return await loadChronologicalSessionHistory(
    `${base}/agent/sessions/${sessionId}/history`,
    token,
    'agent lifecycle session history',
  )
}

async function waitForHistory(
  base: string,
  sessionId: string,
  token: string,
  predicate: (history: ChronologicalSessionHistory) => boolean,
  timeoutMs: number,
): Promise<ChronologicalSessionHistory> {
  const deadline = Date.now() + timeoutMs
  let latest = await loadHistory(base, sessionId, token)
  for (;;) {
    if (predicate(latest)) return latest
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for agent lifecycle history: ${JSON.stringify(
          latest.events.slice(-12).map(row => ({ seq: row.seq, type: row.event.type })),
        )}`,
      )
    }
    await Bun.sleep(POLL_MS)
    latest = await loadHistory(base, sessionId, token)
  }
}

async function waitForJob(
  base: string,
  token: string,
  phase: JobPhase,
  agentId: string,
  sessionId: string,
): Promise<SessionListItem> {
  const deadline = Date.now() + SESSION_WAIT_MS
  for (;;) {
    /* Unfiltered, then the bucket is asserted. `active` was a union of three
       buckets and the list pages by one, so a `bucket=` query here would drop
       two of them and still find nothing to complain about. */
    const listed = await loadAllSessionListItems(
      `${base}/agent/sessions?agentId=${agentId}`,
      token,
      `agent lifecycle ${phase} sessions`,
    )
    const job = listed.find(candidate => candidate.id === sessionId)
    if (
      job !== undefined &&
      (phase === 'finished' ? job.bucket === 'done' : job.bucket !== 'done')
    ) {
      return job
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a ${phase} session ${sessionId}`)
    }
    await Bun.sleep(POLL_MS)
  }
}

async function waitForNoActiveJob(
  base: string,
  token: string,
  agentId: string,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + SESSION_WAIT_MS
  for (;;) {
    const listed = await loadAllSessionListItems(
      `${base}/agent/sessions?agentId=${agentId}`,
      token,
      'agent lifecycle sessions after delete',
    )
    if (!listed.some(candidate => candidate.id === sessionId && candidate.bucket !== 'done')) return
    if (Date.now() >= deadline) {
      throw new Error(`Active job for session ${sessionId} survived agent deletion`)
    }
    await Bun.sleep(POLL_MS)
  }
}

async function resolveVmSshDest(vmName: string | undefined): Promise<string | null> {
  if (vmName === undefined) return null
  const client = new ExeClient({ token: process.env.EXE_TOKEN, connectTimeoutSec: 10 })
  try {
    const vms = await withTimeout(client.list(), EXE_PROBE_TIMEOUT_MS)
    return vms.find(vm => vm.vm_name === vmName)?.ssh_dest ?? null
  } catch {
    // No exe/SSH reachability (e.g. the e2e:staging container): fall back to the
    // in-band teardown proof and record the VM probe as unreachable.
    return null
  }
}

async function probeRunner(sshDest: string, sessionId: string): Promise<string> {
  const client = new ExeClient({ token: process.env.EXE_TOKEN, connectTimeoutSec: 10 })
  const result = await client.exec(sshDest, `pgrep -af ${sessionId} || true`, EXE_PROBE_TIMEOUT_MS)
  return result.stdout
}

async function waitForRunnerAbsent(sshDest: string, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + RUNNER_ABSENCE_WAIT_MS
  for (;;) {
    if (!runnerProcessPresent(await probeRunner(sshDest, sessionId), sessionId)) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(POLL_MS)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('exe probe timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
