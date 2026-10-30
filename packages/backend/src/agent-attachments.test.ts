import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_INPUT_ATTACHMENT_MAX_COUNT,
  MAX_SLUG_LENGTH,
  type AgentEventAttachment,
} from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
  type SignedInUser,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-agent-attachments-internal-key'

let convex: ConvexDevFixture
let owner: SignedInUser<{ _id: string; email: string }>
let sequence = 0

describe('agent session attachments', () => {
  beforeAll(async () => {
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
    owner = await signInWithMagicLink(convex, uniqueEmail('attachment-owner'), 'Attachment Owner')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('prepareRunnerInputDelivery persists attachment metadata in durable history', async () => {
    const workspaceId = await createWorkspace('attachment-history')
    const attachments: AgentEventAttachment[] = [
      {
        path: 'agents/designer/uploads/brand-guide.pdf',
        name: 'Brand Guide.pdf',
        bytes: 42,
        mimeType: 'application/pdf',
      },
    ]
    const prepared = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: {
          principal: { kind: 'human', userId: owner.user._id },
          actorId: owner.user._id,
        },
        workspaceId,
        attemptId: 'attachment-initial',
        now: 1_000,
        input: {
          kind: 'initial_prompt',
          prompt: 'Review the attached brief.',
          behavior: 'steer',
          attachments,
          sender: { kind: 'user', userId: owner.user._id },
        },
      },
    )) as { sessionId: string; dispatch: { message: string } }

    expect(prepared.dispatch.message).toBe(
      `<user_message seq="2" timestamp="1970-01-01T00:00:01.000Z" user_email="${owner.user.email}">Review the attached brief.\n` +
        '  <attached_files note="Files the sender attached to this message, saved into your folder. Read them and organize them into your own structure.">\n' +
        '    <file path="agents/designer/uploads/brand-guide.pdf" bytes="42" mime_type="application/pdf"/>\n' +
        '  </attached_files></user_message>',
    )

    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: prepared.sessionId,
    })) as Array<{ event: Record<string, unknown> }>
    expect(events.find(row => row.event.type === 'prompt_submitted')?.event).toMatchObject({
      prompt: 'Review the attached brief.',
      attachments,
    })
  })

  test('a replay with different attachments conflicts instead of deduplicating', async () => {
    const workspaceId = await createWorkspace('attachment-replay')
    const initial = await prepareInput(workspaceId, {
      attemptId: 'replay-initial',
      input: { kind: 'initial_prompt', prompt: 'Start.', behavior: 'steer' },
    })
    await convex.mutation('domains/agentSessions/model:markRunnerInputDelivered', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: initial.sessionId,
      attemptId: initial.dispatch.attemptId,
      throughSeq: initial.dispatch.throughSeq,
    })

    const clientRequestId = '018f47a0-4dd1-7c2e-9cb7-8f4e71da8c01'
    const original = [attachment('uploads/original.txt')]
    await prepareInput(workspaceId, {
      sessionId: initial.sessionId,
      attemptId: 'replay-original',
      input: {
        kind: 'message',
        prompt: 'Read it.',
        behavior: 'steer',
        clientRequestId,
        attachments: original,
      },
    })

    await expect(
      prepareInput(workspaceId, {
        sessionId: initial.sessionId,
        attemptId: 'replay-conflict',
        input: {
          kind: 'message',
          prompt: 'Read it.',
          behavior: 'steer',
          clientRequestId,
          attachments: [attachment('uploads/replacement.txt')],
        },
      }),
    ).rejects.toThrow(/invalid_request/i)

    const events = await listEvents(workspaceId, initial.sessionId)
    expect(
      events.filter(
        row =>
          row.event.type === 'prompt_submitted' && row.event.clientRequestId === clientRequestId,
      ),
    ).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ attachments: original }),
      }),
    ])
  })

  test('note and answer mutations persist attachment metadata', async () => {
    const workspaceId = await createWorkspace('attachment-input-kinds')
    const initial = await prepareInput(workspaceId, {
      attemptId: 'kinds-initial',
      input: { kind: 'initial_prompt', prompt: 'Start.', behavior: 'steer' },
    })
    await convex.mutation('domains/agentSessions/model:markRunnerInputDelivered', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: initial.sessionId,
      attemptId: initial.dispatch.attemptId,
      throughSeq: initial.dispatch.throughSeq,
    })
    const noteAttachments = [attachment('uploads/context.csv')]
    await convex.mutation('domains/agentSessions/model:appendSessionNote', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId,
      sessionId: initial.sessionId,
      note: 'Use this context.',
      attachments: noteAttachments,
      sender: { kind: 'user', userId: owner.user._id },
    })
    await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: initial.sessionId,
      relayId: crypto.randomUUID(),
      event: {
        type: 'ask',
        state: {
          status: 'waiting_for_human',
          mode: 'agent',
          agent: { status: 'waiting', messages: [] },
        },
        questions: [{ question: 'Approve?', options: [] }],
      },
    })
    const answerAttachments = [attachment('uploads/approval.txt')]
    await prepareInput(workspaceId, {
      sessionId: initial.sessionId,
      attemptId: 'attachment-answer',
      input: {
        kind: 'answer',
        answer: 'Approved.',
        attachments: answerAttachments,
      },
    })

    const events = await listEvents(workspaceId, initial.sessionId)
    expect(events.find(row => row.event.type === 'note_submitted')?.event).toMatchObject({
      note: 'Use this context.',
      attachments: noteAttachments,
    })
    expect(events.find(row => row.event.type === 'answer_submitted')?.event).toMatchObject({
      answer: 'Approved.',
      attachments: answerAttachments,
    })
  })

  test('real Convex inputs reject attachments above the configured cap', async () => {
    const workspaceId = await createWorkspace('attachment-cap')
    await expect(
      prepareInput(workspaceId, {
        attemptId: 'attachment-overflow',
        input: {
          kind: 'initial_prompt',
          prompt: 'Too many.',
          behavior: 'steer',
          attachments: Array.from({ length: AGENT_INPUT_ATTACHMENT_MAX_COUNT + 1 }, (_, index) =>
            attachment(`uploads/file-${index}.txt`),
          ),
        },
      }),
    ).rejects.toThrow()
  })
})

function attachment(path: string): AgentEventAttachment {
  return {
    path,
    name: path.split('/').at(-1)!,
    bytes: 7,
    mimeType: 'text/plain',
  }
}

async function prepareInput(
  workspaceId: string,
  args: {
    sessionId?: string
    attemptId: string
    input:
      | {
          kind: 'initial_prompt' | 'message'
          prompt: string
          behavior: 'steer' | 'follow_up'
          clientRequestId?: string
          attachments?: AgentEventAttachment[]
        }
      | {
          kind: 'answer'
          answer: string
          clientRequestId?: string
          attachments?: AgentEventAttachment[]
        }
  },
): Promise<{
  sessionId: string
  dispatch: { attemptId: string; throughSeq: number }
}> {
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human' as const, userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    ...args,
    input: {
      ...args.input,
      sender: { kind: 'user', userId: owner.user._id },
    },
  })) as {
    sessionId: string
    dispatch: { attemptId: string; throughSeq: number }
  }
}

async function listEvents(
  workspaceId: string,
  sessionId: string,
): Promise<Array<{ event: Record<string, unknown> }>> {
  return (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
  })) as Array<{ event: Record<string, unknown> }>
}

async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  sequence += 1
  const suffix = `-${Date.now()}-${sequence}`
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `${prefix.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`,
    name: `${prefix} workspace`,
  })) as string
}
