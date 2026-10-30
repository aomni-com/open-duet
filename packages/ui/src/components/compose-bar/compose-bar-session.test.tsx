import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { TooltipProvider } from '../shadcn/tooltip'
import { ComposeBar } from './compose-bar'
import { ComposeBarSessionPanel } from './compose-bar-session'
import type { ComposeBarSession } from './types'

test('renders the chat-app question flow inside the compose-bar session panel', () => {
  const session: ComposeBarSession = {
    key: 'session-a:ask-4',
    phase: 'waiting',
    label: 'Duet needs your input',
    questions: {
      key: 'session-a:ask-4',
      items: [
        {
          header: 'Release checks',
          question: 'Which checks should run?',
          options: [{ label: 'Typecheck' }, { label: 'Lint' }],
          multiSelect: true,
        },
      ],
      labels: {
        question: 'Question:',
        fallback: index => `Question ${index}`,
        pending: 'Question pending',
        pendingWithCount: (index, count) => `Question pending · ${index}/${count}`,
        collapse: 'Collapse question',
        expand: 'Expand question',
        previous: 'Previous question',
        next: 'Next question',
        submit: 'Submit',
        doneNext: 'Done — next question',
        doneSubmit: 'Done — submit answers',
        submitError: 'Failed to submit answers',
      },
      onSubmit: async () => {},
    },
  }
  const html = renderToStaticMarkup(<ComposeBarSessionPanel disabled={false} session={session} />)

  expect(html).toContain('data-compose-bar-session="waiting"')
  expect(html).toContain('role="checkbox"')
  expect(html).toContain('>Submit<')
  expect(html.indexOf('>Submit<')).toBeLessThan(html.indexOf('Which checks should run?'))
  expect(html).toContain('Done — submit answers')

  const doneLabelIndex = html.indexOf('Done — submit answers')
  const doneButtonStart = html.lastIndexOf('<button', doneLabelIndex)
  const doneButtonEnd = html.indexOf('>', doneButtonStart)
  expect(html.slice(doneButtonStart, doneButtonEnd)).toContain('disabled=""')
})

test('the running session tray docks directly to the compose surface', () => {
  const session: ComposeBarSession = {
    key: 'session-a:running',
    phase: 'working',
    label: 'Duet is working',
  }
  const labels = {
    list: 'Suggestions',
    loading: 'Loading',
    empty: 'No suggestions',
    unavailable: 'Suggestions unavailable',
  }
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ComposeBar
        value=""
        onValueChange={() => {}}
        onSubmit={() => {}}
        input={{ label: 'Message Duet' }}
        session={session}
        skills={{ items: [], labels }}
        agents={{ items: [], labels }}
      />
    </TooltipProvider>,
  )
  const formStart = html.indexOf('<form')
  const formEnd = html.indexOf('>', formStart)
  const form = html.slice(formStart, formEnd)

  expect(html).toContain('data-compose-bar-session="working"')
  expect(form).not.toContain('mt-2')
})
