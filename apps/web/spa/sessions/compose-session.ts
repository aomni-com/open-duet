import type { ReactNode } from 'react'

import type { SessionSnapshot } from '@repo/contract'
import type { ComposeBarSession, ComposeBarSessionAction } from '@repo/ui/components/compose-bar'

export type ComposeSessionLabels = {
  working: string
  needsInput: string
  sleeping: string
  todos: string
  expandTodos: string
  collapseTodos: string
  todoPending: string
  todoActive: string
  todoComplete: string
  todoFailed: string
}

export type ComposeSessionTones = {
  waiting: string
  sleeping: string
  /** the spinner shown while working when there is no avatar to show instead */
  working: string
}

export type ComposeSessionInput = {
  sessionId: string
  turnStatus: SessionSnapshot['turnStatus']
  /** An input of ours is still in flight; the row's turn state is only assumed. */
  sending?: boolean
  todos: unknown
  questions: unknown
  labels: ComposeSessionLabels
  sleepingHint?: string
  avatar: ReactNode
  todosExpanded: boolean
  onTodosExpandedChange: (expanded: boolean) => void
  action?: ComposeBarSessionAction
  /** App-owned semantic status colors; omit to keep the icons muted. */
  tones?: ComposeSessionTones
}

export function composeSessionFromApi(input: ComposeSessionInput): ComposeBarSession | undefined {
  if (input.turnStatus === 'sleep') {
    return {
      key: `${input.sessionId}:sleep`,
      phase: 'sleeping',
      label: input.labels.sleeping,
      ...(input.tones === undefined ? {} : { tone: input.tones.sleeping }),
      ...(input.sleepingHint === undefined ? {} : { hint: input.sleepingHint }),
      ...(input.action === undefined ? {} : { action: input.action }),
    }
  }

  if (input.turnStatus === 'ask') {
    const question = composeSessionQuestionText(input.questions)
    return {
      key: `${input.sessionId}:ask`,
      phase: 'waiting',
      label: input.labels.needsInput,
      ...(input.tones === undefined ? {} : { tone: input.tones.waiting }),
      ...(question === undefined ? {} : { question }),
    }
  }

  if (input.turnStatus !== 'running') return undefined

  // The task list belongs to the turn the runner is working on. While a
  // message is still on its way there is no such turn yet, and the list on
  // the row is the previous one's.
  const items = input.sending === true ? [] : normalizeTodos(input.todos)
  return {
    key: `${input.sessionId}:running`,
    phase: 'working',
    label: input.labels.working,
    avatar: input.avatar,
    ...(input.tones === undefined ? {} : { tone: input.tones.working }),
    ...(items.length === 0
      ? {}
      : {
          todos: {
            label: input.labels.todos,
            items,
            statusLabels: {
              pending: input.labels.todoPending,
              active: input.labels.todoActive,
              complete: input.labels.todoComplete,
              failed: input.labels.todoFailed,
            },
            expanded: input.todosExpanded,
            expandLabel: input.labels.expandTodos,
            collapseLabel: input.labels.collapseTodos,
            onExpandedChange: input.onTodosExpandedChange,
          },
        }),
    ...(input.action === undefined ? {} : { action: input.action }),
  }
}

export function composeSessionQuestionText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const prompts = value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const raw =
      'question' in item && typeof item.question === 'string'
        ? item.question
        : 'prompt' in item && typeof item.prompt === 'string'
          ? item.prompt
          : undefined
    if (raw === undefined) return []
    const prompt = raw.trim()
    return prompt.length === 0 ? [] : [prompt]
  })
  return prompts.length === 0 ? undefined : prompts.join('\n')
}

function normalizeTodos(value: unknown): NonNullable<ComposeBarSession['todos']>['items'] {
  if (!Array.isArray(value)) return []

  const todos = value.flatMap((item, index) => {
    if (typeof item !== 'object' || item === null) return []

    if (
      'content' in item &&
      typeof item.content === 'string' &&
      'id' in item &&
      typeof item.id === 'string' &&
      item.id.trim().length > 0 &&
      'status' in item &&
      isAgentTodoStatus(item.status)
    ) {
      const label = item.content.trim()
      if (label.length === 0) return []
      return [
        {
          id: item.id,
          label,
          status:
            item.status === 'completed'
              ? ('complete' as const)
              : item.status === 'in_progress'
                ? ('active' as const)
                : item.status,
          promoteIfNoActive: false,
        },
      ]
    }

    if ('text' in item && typeof item.text === 'string' && 'done' in item && item.done === true) {
      const label = item.text.trim()
      return label.length === 0
        ? []
        : [
            {
              id: `todo-${index}`,
              label,
              status: 'complete' as const,
              promoteIfNoActive: false,
            },
          ]
    }
    if ('text' in item && typeof item.text === 'string' && 'done' in item && item.done === false) {
      const label = item.text.trim()
      return label.length === 0
        ? []
        : [
            {
              id: `todo-${index}`,
              label,
              status: 'pending' as const,
              promoteIfNoActive: true,
            },
          ]
    }
    return []
  })
  const activeIndex = todos.some(todo => todo.status === 'active')
    ? -1
    : todos.findIndex(todo => todo.status === 'pending' && todo.promoteIfNoActive)

  const seenIds = new Set<string>()
  return todos.map((todo, index) => {
    const id = seenIds.has(todo.id) ? `${todo.id}-${index}` : todo.id
    seenIds.add(id)
    return {
      id,
      label: todo.label,
      status: index === activeIndex ? 'active' : todo.status,
    }
  })
}

function isAgentTodoStatus(
  value: unknown,
): value is 'pending' | 'in_progress' | 'completed' | 'failed' {
  return (
    value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed'
  )
}
