import type { SessionInputSender, SessionSnapshot, SessionTimelineEntry } from '@repo/contract'

import type { SessionEphemeralFrame } from './index'

export const DEMO_USER_SENDER = {
  kind: 'user',
  userId: 'user_demo',
} as const satisfies SessionInputSender

const WAITING_TURN_STATE = {
  status: 'waiting_for_human' as const,
  mode: 'agent' as const,
  agent: { status: 'waiting' as const, messages: [] },
}

const COMPLETED_TURN_STATE = {
  status: 'completed' as const,
  mode: 'agent' as const,
  agent: { status: 'completed' as const, messages: [] },
}

export const TRANSCRIPT_SNAPSHOT = {
  id: 'session_demo',
  workspaceId: 'workspace_demo',
  audience: { kind: 'workspace' },
  archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
  permissions: {
    send: true,
    answer: true,
    interrupt: true,
    rename: true,
    manageAudience: false,
    personalArchive: true,
    globalArchive: true,
    delete: true,
  },
  turnStatus: 'running',
  bucket: 'running',
  title: 'Investigate the deployment failure',
  titleOrigin: 'auto',
  titleStatus: 'complete',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_003_000,
  lastEventSeq: 6,
  unread: false,
  lastDeliveredInputSeq: 2,
  todos: [
    { id: 'inspect-logs', content: 'Inspect logs', status: 'completed' },
    { id: 'patch-config', content: 'Patch configuration', status: 'pending' },
  ],
} as const satisfies SessionSnapshot

export const TRANSCRIPT_EVENTS = [
  {
    seq: 1,
    createdAt: 1,
    event: {
      type: 'session_created',
      prompt: 'Investigate the deployment failure',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  },
  {
    seq: 2,
    createdAt: 2,
    event: {
      type: 'prompt_submitted',
      prompt: 'Why did staging fail?',
      inputKind: 'initial',
      behavior: 'steer',
      sender: DEMO_USER_SENDER,
    },
  },
  { seq: 3, createdAt: 3, event: { type: 'turn_started' } },
  {
    seq: 4,
    createdAt: 4,
    event: {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'read_logs',
        toolCallId: 'tool-1',
        input: { service: 'web' },
        isError: false,
        output: [{ type: 'text', text: 'Missing DATABASE_URL' }],
      },
    },
  },
  {
    seq: 5,
    createdAt: 5,
    event: {
      type: 'step',
      step: { type: 'text', text: 'The web service is missing DATABASE_URL.' },
    },
  },
  {
    seq: 6,
    createdAt: 6,
    event: {
      type: 'ask',
      state: WAITING_TURN_STATE,
      questions: [{ question: 'Add it to staging?', options: [] }],
    },
  },
] as const satisfies readonly SessionTimelineEntry[]

export const COMPLETE_TRANSCRIPT_EVENTS = [
  ...TRANSCRIPT_EVENTS.slice(0, -1),
  {
    seq: 6,
    createdAt: 6,
    event: {
      type: 'complete',
      state: COMPLETED_TURN_STATE,
      status: 'completed',
      // Terminal events echo the turn's last text step, as the runner sends it.
      result: 'The web service is missing DATABASE_URL.',
    },
  },
] as const satisfies readonly SessionTimelineEntry[]

export const FAILED_TRANSCRIPT_EVENTS = [
  ...TRANSCRIPT_EVENTS.slice(0, 3),
  {
    seq: 4,
    createdAt: 4,
    event: {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'read_logs',
        toolCallId: 'tool-1',
        input: { service: 'web' },
        isError: true,
        output: [{ type: 'text', text: 'Log service unavailable' }],
      },
    },
  },
  {
    seq: 5,
    createdAt: 5,
    event: {
      type: 'interrupted',
      error: 'Runner exited before the session completed.',
    },
  },
] as const satisfies readonly SessionTimelineEntry[]

export const TRANSCRIPT_EPHEMERAL = [
  {
    cursor: 3,
    correlationId: 'tool-1',
    event: {
      type: 'step',
      step: {
        type: 'tool_call_start',
        toolName: 'read_logs',
        toolCallId: 'tool-1',
        input: { service: 'web' },
      },
    },
  },
] as const satisfies readonly SessionEphemeralFrame[]

export const AUTHORED_BOUNDARY_EVENTS = [
  { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
  {
    seq: 2,
    createdAt: 2,
    event: { type: 'step', step: { type: 'text', text: 'I am checking the first service.' } },
  },
  {
    seq: 3,
    createdAt: 3,
    event: {
      type: 'prompt_submitted',
      prompt: 'Check the API too.',
      inputKind: 'message',
      behavior: 'steer',
      sender: DEMO_USER_SENDER,
    },
  },
  {
    seq: 4,
    createdAt: 4,
    event: {
      type: 'todos',
      todos: [{ id: 'api', content: 'Check API logs', status: 'in_progress' }],
    },
  },
  {
    seq: 5,
    createdAt: 5,
    event: { type: 'step', step: { type: 'reasoning', text: 'The failures correlate.' } },
  },
  {
    seq: 6,
    createdAt: 6,
    event: {
      type: 'step',
      step: {
        type: 'tool_call_start',
        toolName: 'read_logs',
        toolCallId: 'tool-api',
        input: { service: 'api' },
      },
    },
  },
  {
    seq: 7,
    createdAt: 7,
    event: {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'read_logs',
        toolCallId: 'tool-api',
        input: { service: 'api' },
        isError: false,
        output: [{ type: 'text', text: 'Missing DATABASE_URL' }],
      },
    },
  },
  {
    seq: 8,
    createdAt: 8,
    event: { type: 'step', step: { type: 'text', text: 'The API has the same missing variable.' } },
  },
  {
    seq: 9,
    createdAt: 9,
    event: {
      type: 'note_submitted',
      note: 'Customer approved the change.',
      sender: DEMO_USER_SENDER,
    },
  },
  {
    seq: 10,
    createdAt: 10,
    event: {
      type: 'answer_submitted',
      answer: 'Production',
      sender: DEMO_USER_SENDER,
    },
  },
  { seq: 11, createdAt: 11, event: { type: 'complete', status: 'completed' } },
] as const satisfies readonly SessionTimelineEntry[]

export const LIVE_DOCUMENT_EVENTS = [
  { seq: 1, createdAt: 1, event: { type: 'turn_started' } },
  {
    seq: 2,
    createdAt: 2,
    event: {
      type: 'todos',
      todos: [{ id: 'logs', content: 'Inspect live logs', status: 'in_progress' }],
    },
  },
] as const satisfies readonly SessionTimelineEntry[]

export const LIVE_DOCUMENT_EPHEMERAL = [
  {
    cursor: 1,
    correlationId: 'live-text',
    event: { type: 'step', step: { type: 'text_delta', delta: 'Still streaming live text.' } },
  },
  {
    cursor: 1,
    correlationId: 'live-reasoning',
    event: { type: 'step', step: { type: 'reasoning_delta', delta: 'Checking the logs.' } },
  },
] as const satisfies readonly SessionEphemeralFrame[]

export const SLEEP_TRANSCRIPT_EVENTS = [
  ...TRANSCRIPT_EVENTS.slice(0, -1),
  {
    seq: 6,
    createdAt: 6,
    event: { type: 'sleep', wakeAt: 1_800_000_000_000 },
  },
] as const satisfies readonly SessionTimelineEntry[]
