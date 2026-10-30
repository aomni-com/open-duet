import assert from 'node:assert/strict'

import { waitForSessionHistory } from './staging-live-agent-sessions.ts'
import { apiJson, bearerJson } from './staging-live-http.ts'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser.ts'

const HUMAN_HANDOFF_WAIT_MS = 720_000

interface HandoffBatch {
  batchId: string
  owner: { kind: 'root' } | { kind: 'agent'; agentId: string }
  tabs: Array<{ targetId?: string }>
}

interface HandoffInventory {
  batches: HandoffBatch[]
}

export interface BrowserHumanHandoffEvidence {
  desktopRoute: string
  question: string
  options: string[]
  handoffTargetId: string
  resumedBatchTargetId: string
  resumedActiveTargetId: string
  freshBatchObserved: true
}

export function browserHumanHandoffPrompt(runId: string): string {
  return [
    'Read and follow the installed workspace-browser skill at ~/.agents/skills/workspace-browser/SKILL.md for this task.',
    `Use the browser to render a large heading reading HANDOFF ${runId} and set the page title to HANDOFF ${runId}.`,
    'Show the person that page and ask them to confirm when they are done inspecting it or say if they are stuck.',
    `After they confirm, continue the browser work, rediscover that page, change the heading to HANDOFF_RESUMED ${runId}, and reply with exactly HANDOFF_RESUMED ${runId}.`,
  ].join(' ')
}

export function handoffTranscript(history: {
  events: Array<{ event: unknown; [key: string]: unknown }>
}): { desktopUrl: string; question: string; options: string[] } | undefined {
  const text = history.events
    .flatMap(row => {
      if (typeof row.event !== 'object' || row.event === null) return []
      const event = row.event as { type?: unknown; step?: unknown }
      if (event.type !== 'step') return []
      const step = event.step
      if (typeof step !== 'object' || step === null) return []
      const type = (step as { type?: unknown }).type
      if (type !== 'text' && type !== 'text_delta') return []
      const value =
        type === 'text' ? (step as { text?: unknown }).text : (step as { delta?: unknown }).delta
      return typeof value === 'string' ? [value] : []
    })
    .join('\n')
  const link = /\/w\/[^\s)]+\/agents\/[^\s)]+\/desktop/.exec(text)?.[0]
  const ask = history.events
    .map(row => row.event)
    .findLast(
      event =>
        typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'ask',
    ) as { questions?: unknown } | undefined
  const questions = ask?.questions
  const firstQuestion = Array.isArray(questions) ? questions[0] : undefined
  const question =
    typeof firstQuestion === 'object' &&
    firstQuestion !== null &&
    typeof (firstQuestion as { question?: unknown }).question === 'string'
      ? (firstQuestion as { question: string }).question
      : undefined
  const rawOptions =
    typeof firstQuestion === 'object' && firstQuestion !== null
      ? (firstQuestion as { options?: unknown }).options
      : undefined
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap(option =>
        typeof option === 'object' &&
        option !== null &&
        typeof (option as { label?: unknown }).label === 'string'
          ? [(option as { label: string }).label]
          : [],
      )
    : []
  return link === undefined || question === undefined
    ? undefined
    : { desktopUrl: link, question, options }
}

export function handoffTurnSettled(history: { events: Array<{ event: unknown }> }): boolean {
  return history.events.some(row => {
    if (typeof row.event !== 'object' || row.event === null) return false
    const type = (row.event as { type?: unknown }).type
    return type === 'ask' || type === 'complete'
  })
}

export function handoffBatchForActiveTarget(
  batches: HandoffBatch[],
  priorBatchIds: ReadonlySet<string>,
  agentId: string,
  activeTargetId: string,
): HandoffBatch | undefined {
  return batches.find(
    batch =>
      batch.owner.kind === 'agent' &&
      batch.owner.agentId === agentId &&
      !priorBatchIds.has(batch.batchId) &&
      batch.tabs.some(tab => tab.targetId === activeTargetId),
  )
}

export async function runBrowserHumanHandoff(
  context: WorkspaceBrowserJourneyContext,
  args: {
    owner: { agentId: string; slug: string; anchorPath: string }
    windowId: number
    readInventory(): Promise<HandoffInventory>
    waitForInventory(predicate: (inventory: HandoffInventory) => boolean): Promise<HandoffInventory>
    readActiveTarget(windowId: number): Promise<string | undefined>
    createSession(args: { label: string; prompt: string; cwd?: string }): Promise<string>
  },
): Promise<BrowserHumanHandoffEvidence> {
  context.progress('agent-browser-windows:8-human-handoff')
  const before = await args.readInventory()
  const oldBatchIds = new Set(before.batches.map(batch => batch.batchId))
  const sessionId = await args.createSession({
    label: 'human-handoff',
    cwd: args.owner.anchorPath,
    prompt: browserHumanHandoffPrompt(context.runId),
  })
  const asking = await waitForSessionHistory(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
    handoffTurnSettled,
    HUMAN_HANDOFF_WAIT_MS,
  )
  const transcript = handoffTranscript(asking)
  if (transcript === undefined) {
    await context.artifacts.writeJson('human-handoff-diagnostic.json', asking)
    throw new Error(
      'browser handoff completed without its link or terminal question; see redacted diagnostic',
    )
  }
  assert.equal(
    transcript.desktopUrl,
    `/w/${context.workspace.slug}/agents/${args.owner.slug}/desktop`,
  )
  assert.deepEqual(transcript.options, ['Done', "I'm stuck"])

  await args.waitForInventory(candidate =>
    candidate.batches.some(
      batch =>
        batch.owner.kind === 'agent' &&
        batch.owner.agentId === args.owner.agentId &&
        !oldBatchIds.has(batch.batchId),
    ),
  )
  const handoffTargetId = await args.readActiveTarget(args.windowId)
  assert(handoffTargetId !== undefined, 'handoff owner window had no active target')
  const initialInventory = await args.waitForInventory(
    candidate =>
      handoffBatchForActiveTarget(
        candidate.batches,
        oldBatchIds,
        args.owner.agentId,
        handoffTargetId,
      ) !== undefined,
  )
  const initialBatch = handoffBatchForActiveTarget(
    initialInventory.batches,
    oldBatchIds,
    args.owner.agentId,
    handoffTargetId,
  )
  assert(initialBatch !== undefined, 'active handoff page did not belong to a new handoff batch')
  const preResumeBatchIds = new Set(initialInventory.batches.map(batch => batch.batchId))

  await apiJson(
    `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions/${sessionId}/answer`,
    {
      method: 'POST',
      headers: bearerJson(context.apiToken),
      body: JSON.stringify({ answer: 'Done', clientRequestId: crypto.randomUUID() }),
    },
    202,
    'answer browser handoff',
    context.artifacts,
  )
  const completedHistory = await waitForSessionHistory(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
    candidate => candidate.events.some(row => row.event.type === 'complete'),
    HUMAN_HANDOFF_WAIT_MS,
  )
  const completed = completedHistory.events.findLast(row => row.event.type === 'complete')
  assert(completed?.event.type === 'complete', 'handoff did not complete after Done')
  const result = completed.event.result
  if (typeof result !== 'string') throw new Error('handoff completion returned no text')
  if (!new RegExp(`HANDOFF_RESUMED ${context.runId}`).test(result)) {
    await context.artifacts.writeJson('human-handoff-diagnostic.json', completedHistory)
  }
  assert.match(result, new RegExp(`HANDOFF_RESUMED ${context.runId}`))

  const resumedInventory = await args.waitForInventory(candidate =>
    candidate.batches.some(
      batch =>
        batch.owner.kind === 'agent' &&
        batch.owner.agentId === args.owner.agentId &&
        !preResumeBatchIds.has(batch.batchId),
    ),
  )
  const resumedBatch = resumedInventory.batches.find(
    batch =>
      batch.owner.kind === 'agent' &&
      batch.owner.agentId === args.owner.agentId &&
      !preResumeBatchIds.has(batch.batchId),
  )
  const resumedBatchTargetId = resumedBatch?.tabs.find(tab => tab.targetId !== undefined)?.targetId
  assert(resumedBatchTargetId !== undefined, 'resumed handoff omitted its fresh target')
  assert.notEqual(
    resumedBatchTargetId,
    handoffTargetId,
    'resumed handoff reused the old target id for its fresh batch',
  )
  const resumedActiveTargetId = await args.readActiveTarget(args.windowId)
  assert.equal(
    resumedActiveTargetId,
    handoffTargetId,
    'resumed handoff did not rediscover and activate the original marked page',
  )
  return {
    desktopRoute: transcript.desktopUrl,
    question: transcript.question,
    options: transcript.options,
    handoffTargetId,
    resumedBatchTargetId,
    resumedActiveTargetId,
    freshBatchObserved: true,
  }
}
