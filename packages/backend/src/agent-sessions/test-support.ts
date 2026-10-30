import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'
import type { Infer } from 'convex/values'

import {
  MAX_SLUG_LENGTH,
  type ActivitySessionSummary,
  type ChatActivity,
  type SessionInputSender,
} from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import type { Id } from '../../convex/_generated/dataModel'
import { runnerDispatchValidator } from '../../convex/domains/agentSessions/model'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..')
export const INTERNAL_KEY = 'test-agent-sessions-internal-key'

export let convex: ConvexDevFixture
export let owner: SignedInUser
let sequence = 0

export type StoredInputImage = {
  storageId: Id<'_storage'>
  mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
  bytes: number
}

export async function startAgentSessionsFixture(): Promise<void> {
  convex = await convexDev(BACKEND_DIR, {
    env: {
      ...generateAuthKeys(),
      DUET_API_INTERNAL_KEY: INTERNAL_KEY,
      DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
      DUET_TEST_AUTH_EMAIL: '1',
      DUET_APP_URL: 'http://localhost:3000',
    },
    reset: true,
  })
  owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('agent-owner'), 'Agent Owner')
}

export async function stopAgentSessionsFixture(): Promise<void> {
  await convex?.stop()
}

export type ActivityOwner = {
  agentId: string
  sessions: ActivitySessionSummary[]
  truncated: boolean
  chat?: ChatActivity
}

/** The ring's read, indexed by owner the way its consumers use it. */
export async function sessionActivity(
  workspaceId: string,
  actorId?: string,
  limitPerAgent = 20,
): Promise<Map<string, ActivityOwner>> {
  const result = (await convex.query('domains/agentSessions/model:sessionActivity', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    limitPerAgent,
    identity:
      actorId === undefined
        ? { principal: { kind: 'workspace' }, actorId: owner.user._id }
        : { principal: { kind: 'human', userId: actorId }, actorId },
  })) as { owners: ActivityOwner[] }
  return new Map(result.owners.map(owner => [owner.agentId, owner]))
}

export async function seedScopedWorkspace(prefix: string): Promise<{
  workspaceId: string
  agentA: { id: string }
  agentB: { id: string }
  root1: { sessionId: string }
  a1: { sessionId: string }
  root2: { sessionId: string }
  a2: { sessionId: string }
  b1: { sessionId: string }
}> {
  const workspaceId = await createWorkspace(prefix)
  const agentA = await registerTestAgent(workspaceId, 'agents/a', 'agent-a', 'Agent A')
  const agentB = await registerTestAgent(workspaceId, 'agents/b', 'agent-b', 'Agent B')
  // Interleave by updatedAt so root and agent rows straddle each other: a root
  // page boundary therefore sits between two attributed rows (the L2 case).
  const root1 = await createSessionInDir(workspaceId, 'root one', 1_000, '')
  const a1 = await createSessionInDir(workspaceId, 'agent a one', 2_000, 'agents/a/x')
  const root2 = await createSessionInDir(workspaceId, 'root two', 3_000, '')
  const a2 = await createSessionInDir(workspaceId, 'agent a two', 4_000, 'agents/a/y')
  const b1 = await createSessionInDir(workspaceId, 'agent b one', 5_000, 'agents/b/z')
  return { workspaceId, agentA, agentB, root1, a1, root2, a2, b1 }
}

export async function registerTestAgent(
  workspaceId: string,
  path: string,
  slug: string,
  name?: string,
): Promise<{ id: string }> {
  return (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path,
    slug,
    ...(name === undefined ? {} : { name }),
  })) as { id: string }
}

export async function createSessionInDir(
  workspaceId: string,
  prompt: string,
  now: number,
  cwd: string,
): Promise<{ sessionId: string }> {
  return (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    prompt,
    now,
    cwd,
  })) as { sessionId: string }
}

/** The list as one member sees it — `unread` is the only viewer-relative field. */
export async function listSessionsAs(
  workspaceId: string,
  actorId: string,
): Promise<Array<{ id: string; unread: boolean; lastEventSeq: number }>> {
  const result = (await convex.query('domains/agentSessions/model:listSessions', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    actorId,
    identity: { principal: { kind: 'human', userId: actorId }, actorId },
  })) as { items: Array<{ id: string; unread: boolean; lastEventSeq: number }> }
  return result.items
}

export async function markSessionRead(
  workspaceId: string,
  sessionId: string,
  actorId: string,
  seq: number,
): Promise<{ lastReadSeq: number }> {
  return (await convex.mutation('domains/agentSessions/model:markSessionRead', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    actorId,
    identity: { principal: { kind: 'human', userId: actorId }, actorId },
    seq,
  })) as { lastReadSeq: number }
}

export async function readCursors(
  workspaceId: string,
  userId: string,
): Promise<Array<{ sessionId: string; lastReadSeq: number }>> {
  return (await convex.query('testing/agentSessions:memberReadCursorsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    userId,
  })) as Array<{ sessionId: string; lastReadSeq: number }>
}

export async function childRowCounts(sessionId: string): Promise<{
  events: number
  relayReceipts: number
  images: number
  reads: number
  memberStates: number
  discovery: number
  toolRouter: number
}> {
  return (await convex.query('testing/agentSessions:childRowCountsForTest', {
    internalKey: INTERNAL_KEY,
    sessionId,
  })) as {
    events: number
    relayReceipts: number
    images: number
    reads: number
    memberStates: number
    discovery: number
    toolRouter: number
  }
}

/** Members who can read but not write \u2014 the weakest role the cursor accepts. */
export async function addReaders(
  workspaceId: string,
  prefix: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail(`${prefix}-reader-${index}`),
      `${prefix} reader ${index}`,
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'viewer',
    })
    ids.push(member.user._id)
  }
  return ids
}

/** Run the cascade to completion the way the scheduler would. */
export async function drainDeleteBatches(sessionId: string): Promise<void> {
  const workId = (await convex.mutation(
    'testing/agentSessions:prepareSessionDeletionCleanupForTest',
    { internalKey: INTERNAL_KEY, sessionId },
  )) as string
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = (await convex.mutation(
      'testing/agentSessions:runSessionDeletionCleanupForTest',
      {
        internalKey: INTERNAL_KEY,
        workId,
      },
    )) as { done: boolean }
    if (result.done) return
  }
  throw new Error('delete cascade did not finish in 20 batches')
}

export async function setSessionGlobalArchive(
  workspaceId: string,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  await convex.mutation('domains/agentSessions/model:setSessionArchive', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    kind: 'global',
    workspaceId,
    sessionId,
    archived,
  })
}

export type DefaultSessionOwnerSpec = { kind: 'root' } | { kind: 'agent'; agentId: string }

/** The only writer that mints a default chat: the alias's own first message. */
export async function deliverDefault(
  workspaceId: string,
  ownerSpec: DefaultSessionOwnerSpec,
  prompt: string,
  attemptId: string,
  now: number,
  cwd?: string,
): Promise<{ sessionId: string; created?: unknown }> {
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    defaultOwner: ownerSpec,
    attemptId,
    input: {
      sender: { kind: 'user', userId: owner.user._id },
      kind: 'initial_prompt',
      prompt,
      behavior: 'steer',
      ...(cwd === undefined ? {} : { cwd }),
    },
    now,
  })) as { sessionId: string; created?: unknown }
}

export async function getDefaultSession(
  workspaceId: string,
  ownerSpec: DefaultSessionOwnerSpec,
): Promise<Record<string, unknown> | null> {
  return (await convex.query('domains/agentSessions/model:getDefaultSession', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    owner: ownerSpec,
    identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
  })) as Record<string, unknown> | null
}

export async function setDefaultSession(
  workspaceId: string,
  ownerSpec: DefaultSessionOwnerSpec,
  sessionId: string | null,
  actorId: string = owner.user._id,
): Promise<Record<string, unknown> | null> {
  return (await convex.mutation('domains/agentSessions/model:setDefaultSession', {
    internalKey: INTERNAL_KEY,
    actorId,
    identity: { principal: { kind: 'human', userId: actorId }, actorId },
    workspaceId,
    owner: ownerSpec,
    sessionId,
  })) as Record<string, unknown> | null
}

export async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} workspace`,
  })) as string
}

export async function createSession(
  workspaceId: string,
  prompt: string,
): Promise<{
  sessionId: string
  status: string
  lastEventSeq: number
  lastDeliveredInputSeq: number
}> {
  return (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    prompt,
  })) as { sessionId: string; status: string; lastEventSeq: number; lastDeliveredInputSeq: number }
}

export async function createSessionAt(
  workspaceId: string,
  prompt: string,
  now: number,
): Promise<{
  sessionId: string
  status: string
  lastEventSeq: number
  lastDeliveredInputSeq: number
}> {
  return (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    prompt,
    now,
  })) as { sessionId: string; status: string; lastEventSeq: number; lastDeliveredInputSeq: number }
}

export async function appendSessionNote(
  workspaceId: string,
  sessionId: string,
  note: string,
  images?: StoredInputImage[],
): Promise<{ status: string; seq: number; lastEventSeq: number }> {
  return (await convex.mutation('domains/agentSessions/model:appendSessionNote', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId,
    note,
    sender: { kind: 'user', userId: owner.user._id },
    ...(images === undefined ? {} : { images }),
  })) as { status: string; seq: number; lastEventSeq: number }
}

export async function appendSessionNoteAt(
  workspaceId: string,
  sessionId: string,
  note: string,
  now: number,
): Promise<{ status: string; seq: number; lastEventSeq: number }> {
  return (await convex.mutation('domains/agentSessions/model:appendSessionNote', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId,
    note,
    sender: { kind: 'user', userId: owner.user._id },
    now,
  })) as { status: string; seq: number; lastEventSeq: number }
}

export async function appendNoteAs(
  workspaceId: string,
  sessionId: string,
  note: string,
  sender: SessionInputSender,
  now: number,
): Promise<{ status: string; seq: number; lastEventSeq: number }> {
  return (await convex.mutation('domains/agentSessions/model:appendSessionNote', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId,
    note,
    sender,
    now,
  })) as { status: string; seq: number; lastEventSeq: number }
}

export async function renameUser(
  userId: string,
  firstName: string,
  lastName: string,
  now: number,
): Promise<void> {
  await convex.mutation('domains/users/api:updateProfile', {
    internalKey: INTERNAL_KEY,
    actorId: userId,
    firstName,
    lastName,
    now,
  })
}

/**
 * Derived from the mutation's own validator rather than restated here. A
 * hand-copied dispatch shape is a second declaration of a contract that already
 * has one, and it drifts silently: a field added to the mutation typechecks
 * against the old copy and only fails at runtime.
 */
export type PreparedDelivery = {
  sessionId: string
  status: string
  dispatch: Infer<typeof runnerDispatchValidator>
}

export async function prepareRunnerInputDelivery(
  workspaceId: string,
  args: {
    sessionId?: string
    identity?:
      | { principal: { kind: 'human'; userId: string }; actorId: string }
      | { principal: { kind: 'workspace' }; actorId: string }
    attemptId: string
    input:
      | {
          kind: 'initial_prompt'
          prompt: string
          behavior?: 'steer' | 'follow_up'
          clientRequestId?: string
          clientRequestFingerprint?: string
          cwd?: string
          images?: StoredInputImage[]
          tier?: string
          audience?: { kind: 'workspace' } | { kind: 'specific'; memberUserIds: string[] }
          sender?: SessionInputSender
        }
      | {
          kind: 'message'
          prompt: string
          behavior?: 'steer' | 'follow_up'
          clientRequestId?: string
          clientRequestFingerprint?: string
          images?: StoredInputImage[]
          tier?: string
          sender?: SessionInputSender
        }
      | {
          kind: 'answer'
          answer: string
          clientRequestId?: string
          clientRequestFingerprint?: string
          images?: StoredInputImage[]
          sender?: SessionInputSender
        }
      | { kind: 'drain' }
    now?: number
  },
): Promise<PreparedDelivery> {
  const sender: SessionInputSender =
    args.input.kind === 'drain'
      ? { kind: 'system' }
      : (args.input.sender ?? { kind: 'user', userId: owner.user._id })
  const input =
    args.input.kind === 'drain'
      ? args.input
      : args.input.kind === 'answer'
        ? { ...args.input, sender }
        : { behavior: 'steer' as const, ...args.input, sender }
  const identity =
    args.identity ??
    ({
      principal: { kind: 'human' as const, userId: owner.user._id },
      actorId: owner.user._id,
    } as const)
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    ...args,
    input,
    ...(args.input.kind === 'drain' ? {} : { actorId: identity.actorId, identity }),
  })) as PreparedDelivery
}

// The model envelope this suite's owner renders into. `timestamp` is the row's
// own durable clock, read back from the timeline rather than restated, and the
// name/email are the CURRENT user row's — the exact grammar is owned by the
// renderer's byte fixtures in convex/domains/agentSessions/runnerEnvelope.test.ts.
export function ownerEnvelope(spec: {
  seq: number
  at: number
  body: string
  role?: 'message' | 'note'
  answer?: true
}): string {
  const element = `user_${spec.role ?? 'message'}`
  const kind = spec.answer === true ? ' kind="answer"' : ''
  // A magic-link account carries no profile name until one is set, so the
  // owner legitimately renders without `user_full_name`.
  const fullName = owner.user.name === undefined ? '' : ` user_full_name="${owner.user.name}"`
  return (
    `<${element} seq="${spec.seq}" timestamp="${new Date(spec.at).toISOString()}"${kind}` +
    `${fullName} user_email="${owner.user.email}">${spec.body}</${element}>`
  )
}

export async function rowCreatedAt(
  workspaceId: string,
  sessionId: string,
  seq: number,
): Promise<number> {
  const row = (await listEvents(workspaceId, sessionId)).find(event => event.seq === seq)
  if (row === undefined) throw new Error(`No event at seq ${seq}`)
  return row.createdAt
}

export async function storeInputImages(
  images: Array<{ data: string; mimeType: string }>,
): Promise<StoredInputImage[]> {
  return (await convex.action('domains/agentSessions/model:storeInputImages', {
    internalKey: INTERNAL_KEY,
    images,
  })) as StoredInputImage[]
}

export async function markRunnerInputDelivered(
  workspaceId: string,
  sessionId: string,
  attemptId: string,
  throughSeq: number,
): Promise<Record<string, unknown>> {
  return (await convex.mutation('domains/agentSessions/model:markRunnerInputDelivered', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    attemptId,
    throughSeq,
  })) as Record<string, unknown>
}

export async function abandonRunnerInputDelivery(
  workspaceId: string,
  sessionId: string,
  attemptId: string,
): Promise<Record<string, unknown>> {
  return (await convex.mutation('domains/agentSessions/model:abandonRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    attemptId,
  })) as Record<string, unknown>
}

export async function relay(
  workspaceId: string,
  sessionId: string,
  event: Record<string, unknown>,
  relayId: string = crypto.randomUUID(),
  now?: number,
  acceptedThroughSeq?: number,
): Promise<{ status: string; lastEventSeq: number; accepted: boolean; seq: number | null }> {
  return (await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    relayId,
    event,
    ...(now === undefined ? {} : { now }),
    ...(acceptedThroughSeq === undefined ? {} : { acceptedThroughSeq }),
  })) as { status: string; lastEventSeq: number; accepted: boolean; seq: number | null }
}

export async function findCoveringTerminal(
  workspaceId: string,
  sessionId: string,
  inputSeq: number,
): Promise<{
  seq: number
  event: Record<string, unknown>
  createdAt: number
  cwd?: string
} | null> {
  return (await convex.query('domains/agentSessions/model:findCoveringTerminal', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    inputSeq,
  })) as { seq: number; event: Record<string, unknown>; createdAt: number; cwd?: string } | null
}

export async function getSession(
  workspaceId: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  return (await convex.query('domains/agentSessions/model:getSession', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
  })) as Record<string, unknown> | null
}

export async function listEvents(
  workspaceId: string,
  sessionId: string,
): Promise<
  Array<{ seq: number; event: { type: string } & Record<string, unknown>; createdAt: number }>
> {
  return (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
  })) as Array<{
    seq: number
    event: { type: string } & Record<string, unknown>
    createdAt: number
  }>
}

export async function listSessionHistoryPage(
  workspaceId: string,
  sessionId: string,
  args: { cursor?: string; limit?: number; order?: 'asc' | 'desc'; afterSeq?: number } = {},
) {
  return (await convex.query('domains/agentSessions/model:listSessionHistoryPage', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
    ...args,
  })) as {
    items: Array<{ seq: number; event: { type: string }; createdAt: number }>
    nextCursor: string | null
  }
}

export async function listDefaultSessionHistoryPage(
  workspaceId: string,
  ownerSpec: DefaultSessionOwnerSpec,
  args: { cursor?: string; limit?: number; order?: 'asc' | 'desc'; afterSeq?: number } = {},
) {
  return (await convex.query('domains/agentSessions/model:listDefaultSessionHistoryPage', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    owner: ownerSpec,
    identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
    ...args,
  })) as {
    items: Array<{ seq: number; event: { type: string }; createdAt: number }>
    nextCursor: string | null
  }
}

export async function listSessions(
  workspaceId: string,
  args: {
    cursor?: string
    limit?: number
    actorId?: string
    search?: string
    bucket?: 'asking' | 'running' | 'scheduled' | 'done'
    archived?: 'exclude' | 'only'
    agentId?: string
    excludeDefault?: true
    topLevel?: true
  } = {},
): Promise<{ items: ListedSession[]; nextCursor: string | null }> {
  const identity =
    args.actorId === undefined
      ? { principal: { kind: 'workspace' as const }, actorId: owner.user._id }
      : {
          principal: { kind: 'human' as const, userId: args.actorId },
          actorId: args.actorId,
        }
  return (await convex.query('domains/agentSessions/model:listSessions', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    identity,
    ...args,
  })) as { items: ListedSession[]; nextCursor: string | null }
}

export async function listChildSessions(
  workspaceId: string,
  parentSessionId: string,
  args: {
    cursor?: string
    limit?: number
    actorId?: string
    bucket?: 'asking' | 'running' | 'scheduled' | 'done'
    archived?: 'exclude' | 'only'
  } = {},
): Promise<{ items: ListedSession[]; nextCursor: string | null }> {
  const identity =
    args.actorId === undefined
      ? { principal: { kind: 'workspace' as const }, actorId: owner.user._id }
      : {
          principal: { kind: 'human' as const, userId: args.actorId },
          actorId: args.actorId,
        }
  return (await convex.query('domains/agentSessions/model:listChildSessions', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    parentSessionId,
    identity,
    ...args,
  })) as { items: ListedSession[]; nextCursor: string | null }
}

export type ListedSession = {
  id: string
  unread: boolean
  turnStatus: string
  bucket: 'asking' | 'running' | 'scheduled' | 'done'
  title: string
  titleOrigin: string
  titleStatus: string
  createdAt: number
  updatedAt: number
  lastEventSeq: number
  agent?: { id: string; name: string }
  machine?: {
    step?: string
    progress?: { completed: number; total: number }
    activity: string
    outcome?: string
    nextWakeAt?: number
  }
}

/**
 * The old two-view job list, asked of the one session list.
 *
 * These tests are about the state-machine lifecycle, so they still want the
 * question the split API used to answer: which machines are live, which are
 * over. Reading them through that shape — rather than rewriting every
 * assertion — is also the proof that the merged list answers it. A "job" is
 * simply a session carrying a `machine`; `active` is the three unfinished
 * buckets, `history` is `done`.
 *
 * Pass `bucket` when the assertion needs real cursor paging: a cursor belongs
 * to one index range, so it cannot span the three buckets `active` unions.
 */
export async function listJobs(
  workspaceId: string,
  args: {
    cursor?: string
    limit?: number
    search?: string
    view: 'active' | 'history'
    bucket?: 'asking' | 'running' | 'scheduled'
    agentId?: string
  },
): Promise<{ jobs: ListedSession[]; nextCursor?: string }> {
  const { view, bucket, ...rest } = args
  const buckets =
    view === 'history'
      ? (['done'] as const)
      : ([bucket ?? 'asking', 'running', 'scheduled'] as const)
  const wanted = bucket === undefined ? buckets : ([bucket] as const)
  const pages = await Promise.all(
    [...new Set(wanted)].map(each => listSessions(workspaceId, { ...rest, bucket: each })),
  )
  const jobs = pages
    .flatMap(page => page.items)
    .filter(session => session.machine !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const nextCursor = pages.find(page => page.nextCursor !== null)?.nextCursor ?? undefined
  return {
    jobs,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

export async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(25)
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('eventually timed out')
}

export function stateMachineFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    definition: {
      name: 'Milk reminder',
      prompt: 'Wait, remind, then finish.',
      states: [
        { name: 'wait', kind: 'timer', wakeAfterMs: '1h' },
        { name: 'remind', kind: 'agent', prompt: 'Remind the user.' },
        { name: 'done', kind: 'terminal', status: 'completed' },
        { name: 'failed', kind: 'terminal', status: 'failed' },
      ],
    },
    prompt: 'Remind me to get milk.',
    currentState: 'wait',
    progress: { states: { wait: { runs: 1, sleeps: 0 } } },
    history: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

export function turnStateWithMachine(
  status: 'completed' | 'interrupted',
  agentStatus: 'completed' | 'cancelled',
  stateMachine: Record<string, unknown>,
) {
  return {
    status,
    mode: stateMachine.definition,
    agent: { status: agentStatus, messages: [] },
    stateMachine,
  }
}

export function terminalEvent(
  type: 'complete' | 'ask' | 'interrupted' | 'sleep',
): Record<string, unknown> {
  if (type === 'complete')
    return { type, state: completedTurnState(), status: 'completed', result: 'done' }
  if (type === 'ask')
    return {
      type,
      state: waitingTurnState(),
      questions: [{ question: 'Approve?', options: [] }],
    }
  if (type === 'interrupted') return { type, state: interruptedTurnState() }
  return { type, state: sleepingTurnState(), wakeAt: 1_783_440_000_000 }
}

export function runningTurnState() {
  return {
    status: 'running' as const,
    mode: 'agent' as const,
    agent: { status: 'running' as const, messages: [] },
  }
}

export function completedTurnState() {
  return {
    status: 'completed' as const,
    mode: 'agent' as const,
    agent: { status: 'completed' as const, messages: [] },
  }
}

export function waitingTurnState() {
  return {
    status: 'waiting_for_human' as const,
    mode: 'agent' as const,
    agent: { status: 'waiting' as const, messages: [] },
  }
}

export function interruptedTurnState() {
  return {
    status: 'interrupted' as const,
    mode: 'agent' as const,
    agent: { status: 'cancelled' as const, messages: [] },
  }
}

export function sleepingTurnState() {
  return {
    status: 'sleeping' as const,
    mode: 'agent' as const,
    agent: { status: 'waiting' as const, messages: [] },
  }
}

// The uniqueness suffix is 15+ characters, so a descriptive prefix silently
// pushed slugs past MAX_SLUG_LENGTH once the sequence reached two digits —
// which made ADDING a test fail unrelated tests. Trim the prefix to whatever
// the limit leaves rather than rationing prefix length by hand.
export function uniqueSlug(prefix: string): string {
  sequence += 1
  const suffix = `-${Date.now()}-${sequence}`
  /* Trimmed *after* the cut. The cut point moves with the suffix's own length —
     a two-digit sequence takes one more character than a one-digit one — so a
     prefix that survives today lands on its own hyphen the moment a test is
     added ahead of it, and `a--1787…` is not a slug. That failure reads as
     "this unrelated test is broken", which is a whole session to unpick. */
  const head = prefix.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '')
  return `${head}${suffix}`
}

export interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

export interface UserRow {
  _id: string
  email: string
  name?: string
}
