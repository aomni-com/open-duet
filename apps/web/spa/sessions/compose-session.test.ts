import { describe, expect, test } from 'bun:test'

import { composeSessionFromApi } from './compose-session'

const LABELS = {
  working: 'Duet is working',
  needsInput: 'Duet needs your input',
  sleeping: 'Duet has a reminder set for an upcoming scheduled task.',
  todos: 'Session tasks',
  expandTodos: 'Expand session tasks',
  collapseTodos: 'Collapse session tasks',
  todoPending: 'Pending',
  todoActive: 'In progress',
  todoComplete: 'Complete',
  todoFailed: 'Failed',
} as const

const TONES = {
  waiting: 'tone-waiting',
  sleeping: 'tone-sleeping',
  working: 'tone-working',
} as const
const AVATAR = 'canonical agent avatar'

describe('composeSessionFromApi', () => {
  /* The task list belongs to a turn the runner is actually working: while a
     message is still on its way the row is only optimistically running, and
     the list it would show is the previous turn's. */
  test("a message still being sent shows working, not the last turn's tasks", () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'running',
      sending: true,
      todos: [{ id: 'a', content: 'Remove the old ZIP', status: 'completed' }],
      questions: undefined,
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
    })

    expect(session).toMatchObject({ phase: 'working', label: 'Duet is working' })
    expect(session).not.toHaveProperty('todos')
  })

  test('maps a running session and its current todo progress into the compose capability', () => {
    const onExpandedChange = () => undefined
    const onInterrupt = () => undefined

    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'running',
      todos: [
        { text: 'Inspect logs', done: true },
        { text: 'Patch configuration', done: false },
        { text: 'Verify staging', done: false },
      ],
      questions: undefined,
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: onExpandedChange,
      action: {
        label: 'Interrupt',
        pendingLabel: 'Interrupting',
        onSelect: onInterrupt,
      },
    })

    expect(session).toEqual({
      key: 'session-1:running',
      phase: 'working',
      label: 'Duet is working',
      avatar: AVATAR,
      todos: {
        label: 'Session tasks',
        items: [
          { id: 'todo-0', label: 'Inspect logs', status: 'complete' },
          { id: 'todo-1', label: 'Patch configuration', status: 'active' },
          { id: 'todo-2', label: 'Verify staging', status: 'pending' },
        ],
        statusLabels: {
          pending: 'Pending',
          active: 'In progress',
          complete: 'Complete',
          failed: 'Failed',
        },
        expanded: true,
        expandLabel: 'Expand session tasks',
        collapseLabel: 'Collapse session tasks',
        onExpandedChange,
      },
      action: {
        label: 'Interrupt',
        pendingLabel: 'Interrupting',
        onSelect: onInterrupt,
      },
    })
  })

  test('maps only the current ask prompt into a waiting session', () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'ask',
      todos: [{ text: 'Stale work', done: false }],
      questions: [{ id: 'q1', prompt: 'Add the variable to staging?' }],
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
      action: { label: 'Interrupt', onSelect: () => undefined },
    })

    expect(session).toEqual({
      key: 'session-1:ask',
      phase: 'waiting',
      label: 'Duet needs your input',
      question: 'Add the variable to staging?',
    })
  })

  test('keeps the stop action available while a session sleeps', () => {
    const onInterrupt = () => undefined
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'sleep',
      todos: [{ text: 'Stale work', done: false }],
      questions: [{ prompt: 'Stale question' }],
      labels: LABELS,
      sleepingHint: 'Chat with Duet anytime in the meantime.',
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
      action: {
        label: 'Stop',
        pendingLabel: 'Stopping',
        ariaLabel: 'Stop session',
        title: 'Stop session',
        onSelect: onInterrupt,
      },
    })

    expect(session).toEqual({
      key: 'session-1:sleep',
      phase: 'sleeping',
      label: 'Duet has a reminder set for an upcoming scheduled task.',
      hint: 'Chat with Duet anytime in the meantime.',
      action: {
        label: 'Stop',
        pendingLabel: 'Stopping',
        ariaLabel: 'Stop session',
        title: 'Stop session',
        onSelect: onInterrupt,
      },
    })
  })

  test('normalizes the installed agent runtime todo shape without losing failed work', () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'running',
      todos: [
        { id: 'inspect', content: 'Inspect logs', status: 'completed' },
        { id: 'patch', content: 'Patch configuration', status: 'in_progress' },
        { id: 'verify', content: 'Verify staging', status: 'pending' },
        { id: 'deploy', content: 'Deploy production', status: 'failed' },
      ],
      questions: undefined,
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: false,
      onTodosExpandedChange: () => undefined,
    })

    expect(session?.todos?.items).toEqual([
      { id: 'inspect', label: 'Inspect logs', status: 'complete' },
      { id: 'patch', label: 'Patch configuration', status: 'active' },
      { id: 'verify', label: 'Verify staging', status: 'pending' },
      { id: 'deploy', label: 'Deploy production', status: 'failed' },
    ])
  })

  test('keeps installed agent pending work pending when nothing is in progress', () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'running',
      todos: [
        { id: 'inspect', content: 'Inspect logs', status: 'pending' },
        { id: 'patch', content: 'Patch configuration', status: 'pending' },
      ],
      questions: undefined,
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
    })

    expect(session?.todos?.items).toEqual([
      { id: 'inspect', label: 'Inspect logs', status: 'pending' },
      { id: 'patch', label: 'Patch configuration', status: 'pending' },
    ])
  })

  test('normalizes the installed agent question text into the free-text answer prompt', () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'ask',
      todos: undefined,
      questions: [
        {
          question: 'Which environment should receive the fix?',
          header: 'Deployment target',
          options: [{ label: 'Staging' }, { label: 'Production' }],
        },
        { prompt: 'Who should own the rollout?' },
      ],
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
    })

    expect(session?.question).toBe(
      'Which environment should receive the fix?\nWho should own the rollout?',
    )
  })

  test.each(['not-an-array', ['not-an-object']])(
    'drops malformed ask questions instead of rendering transport data: %j',
    questions => {
      const session = composeSessionFromApi({
        sessionId: 'session-1',
        turnStatus: 'ask',
        todos: undefined,
        questions,
        labels: LABELS,
        avatar: AVATAR,
        todosExpanded: true,
        onTodosExpandedChange: () => undefined,
      })

      expect(session).toEqual({
        key: 'session-1:ask',
        phase: 'waiting',
        label: 'Duet needs your input',
      })
    },
  )

  test.each(['complete', 'interrupted'] as const)(
    'omits the session capability for the terminal %s status',
    turnStatus => {
      expect(
        composeSessionFromApi({
          sessionId: 'session-1',
          turnStatus,
          todos: [{ text: 'Stale work', done: false }],
          questions: [{ prompt: 'Stale question' }],
          labels: LABELS,
          avatar: AVATAR,
          todosExpanded: true,
          onTodosExpandedChange: () => undefined,
          action: { label: 'Interrupt', onSelect: () => undefined },
        }),
      ).toBeUndefined()
    },
  )

  test('drops malformed API records instead of inventing session work', () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'running',
      todos: [
        null,
        { id: 'empty', content: '  ', status: 'in_progress' },
        { content: 'No stable id', status: 'pending' },
        { id: 'unknown', content: 'Unsupported state', status: 'blocked' },
        { text: 'Missing completion flag' },
      ],
      questions: 'not-an-array',
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: false,
      onTodosExpandedChange: () => undefined,
    })

    expect(session).toEqual({
      key: 'session-1:running',
      phase: 'working',
      label: 'Duet is working',
      avatar: AVATAR,
    })
  })

  test('tints every phase with the tone the app supplies for it', () => {
    const base = {
      sessionId: 'session-1',
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
      tones: TONES,
    }

    const sleeping = composeSessionFromApi({
      ...base,
      turnStatus: 'sleep',
      todos: undefined,
      questions: undefined,
    })
    const waiting = composeSessionFromApi({
      ...base,
      turnStatus: 'ask',
      todos: undefined,
      questions: [{ prompt: 'Who should own the rollout?' }],
    })
    const working = composeSessionFromApi({
      ...base,
      turnStatus: 'running',
      todos: undefined,
      questions: undefined,
    })

    expect(sleeping?.tone).toBe('tone-sleeping')
    expect(waiting?.tone).toBe('tone-waiting')
    expect(working?.tone).toBe('tone-working')
  })

  test('disambiguates duplicate installed todo ids so React keys stay stable', () => {
    const session = composeSessionFromApi({
      sessionId: 'session-1',
      turnStatus: 'running',
      todos: [
        { id: 'dup', content: 'First task', status: 'in_progress' },
        { id: 'dup', content: 'Second task', status: 'pending' },
      ],
      questions: undefined,
      labels: LABELS,
      avatar: AVATAR,
      todosExpanded: true,
      onTodosExpandedChange: () => undefined,
    })

    expect(session?.todos?.items).toEqual([
      { id: 'dup', label: 'First task', status: 'active' },
      { id: 'dup-1', label: 'Second task', status: 'pending' },
    ])
  })
})
