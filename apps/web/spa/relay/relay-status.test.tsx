import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentStateMachineSession, Machine } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { RelayPathDisclosure, RelayStatus } from './relay-status'

test('renders the chat-app relay header contract from the classified definition path', () => {
  const summary: Machine = {
    definitionName: 'Quarterly customer export',
    currentState: 'Wait for approval',
    followingDefinitionState: 'Publish the export',
    progress: { completed: 2, total: 5 },
    orderedPath: [
      { key: 'repeat-past', index: 0, name: 'Wait for approval', kind: 'timer', phase: 'past' },
      { key: 'current', index: 3, name: 'Wait for approval', kind: 'park', phase: 'current' },
      { key: 'future', index: 4, name: 'Publish the export', kind: 'script', phase: 'future' },
    ],
    activity: 'sleeping',
  }

  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <RelayStatus summary={summary} />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('role="status"')
  expect(html).toContain(
    'aria-label="Active relay: Quarterly customer export. Current: Wait for approval. Next: Publish the export. 2 of 5."',
  )
  expect(html).toContain('>2/5<')
  expect(html).toContain('data-relay-kind="park"')
  expect(html).not.toContain('data-relay-kind="timer"')
})

test('announces unknown progress before the backend classifies a current step', () => {
  const summary: Machine = {
    definitionName: 'Awaiting first runner snapshot',
    progress: { completed: 0, total: 3 },
    orderedPath: [{ key: 'future', index: 0, name: 'Start work', kind: 'agent', phase: 'future' }],
    activity: 'idle',
  }

  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <RelayStatus summary={summary} />
    </NextIntlClientProvider>,
  )

  expect(html).toContain(
    'aria-label="Active relay: Awaiting first runner snapshot. Current: Awaiting first runner snapshot. Next: Start work. Step unknown of 3."',
  )
})

test('renders the retained definition path from stable backend item identity', () => {
  const summary: Machine = {
    definitionName: 'Approval retry relay',
    currentState: 'Wait for approval',
    progress: { completed: 1, total: 3 },
    orderedPath: [
      { key: 'first-wait', index: 0, name: 'Wait for approval', kind: 'timer', phase: 'past' },
      {
        key: 'second-wait',
        index: 1,
        name: 'Wait for approval',
        kind: 'park',
        phase: 'current',
      },
      {
        key: 'extension',
        index: 2,
        name: 'Run provider extension',
        kind: 'provider-specific',
        phase: 'future',
      },
    ],
    activity: 'sleeping',
  }

  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <RelayPathDisclosure summary={summary} surface="popover" />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('>Relay<')
  expect(html).toContain('>Approval retry relay<')
  expect(html).toContain('data-relay-item-id="0:first-wait:past"')
  expect(html).toContain('data-relay-item-id="1:second-wait:current"')
  const currentItems = [...html.matchAll(/<li[^>]*aria-current="step"[^>]*>/g)].map(
    match => match[0],
  )
  expect(currentItems).toHaveLength(1)
  expect(currentItems[0]).toContain('data-relay-item-id="1:second-wait:current"')
  expect(html).toContain('data-relay-kind="provider-specific"')
})

test('renders the definition prompt, state configuration trigger, and grouped outcomes', () => {
  const summary: Machine = {
    definitionName: 'Release relay',
    currentState: 'Verify release',
    progress: { completed: 0, total: 2 },
    orderedPath: [
      { key: 'state:0', index: 0, name: 'Verify release', kind: 'agent', phase: 'current' },
      { key: 'state:1', index: 1, name: 'Publish release', kind: 'script', phase: 'future' },
      {
        key: 'state:2',
        index: 2,
        name: 'Done',
        kind: 'terminal',
        phase: 'outcome',
        terminalStatus: 'completed',
      },
      {
        key: 'state:3',
        index: 3,
        name: 'Failed',
        kind: 'terminal',
        phase: 'outcome',
        terminalStatus: 'failed',
      },
    ],
    activity: 'running',
  }
  const stateMachine: AgentStateMachineSession = {
    definition: {
      name: 'Release relay',
      prompt: 'Use this relay for production releases that require verification.',
      states: [
        { name: 'Verify release', kind: 'agent', prompt: 'Run the release checks.' },
        { name: 'Publish release', kind: 'script', command: 'scripts/publish-release.sh' },
        { name: 'Done', kind: 'terminal', status: 'completed' },
        { name: 'Failed', kind: 'terminal', status: 'failed' },
      ],
    },
    prompt: 'Ship version 3.2.0.',
    currentState: 'Verify release',
    history: [],
    createdAt: 1,
    updatedAt: 2,
  }

  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <RelayPathDisclosure summary={summary} stateMachine={stateMachine} surface="popover" />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Use this relay for production releases that require verification.')
  expect(html).toContain('aria-label="View Verify release configuration"')
  expect(html).toContain('Outcomes')
  expect(html).toContain('>Complete<')
  expect(html).toContain('>Failed<')
  expect(html.match(/data-relay-item-phase="outcome"/g)).toHaveLength(1)
})
