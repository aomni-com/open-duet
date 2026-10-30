import { expect, test } from 'bun:test'

import { handOffComposerDraft, takeComposerDraft } from './composer-handoff'

test('words written before a conversation had an id reach the conversation it became', async () => {
  handOffComposerDraft('acme', 'session-1', 'and also check the logs')

  expect(takeComposerDraft('acme', 'session-1')).toBe('and also check the logs')
  // A development double mount reads it again in the same commit.
  expect(takeComposerDraft('acme', 'session-1')).toBe('and also check the logs')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(takeComposerDraft('acme', 'session-1')).toBeUndefined()
})

test('a handoff belongs to one conversation in one workspace', () => {
  handOffComposerDraft('acme', 'session-2', 'next message')

  expect(takeComposerDraft('acme', 'session-3')).toBeUndefined()
  expect(takeComposerDraft('globex', 'session-2')).toBeUndefined()
})

test('nothing typed is nothing handed off', () => {
  handOffComposerDraft('acme', 'session-4', '   ')

  expect(takeComposerDraft('acme', 'session-4')).toBeUndefined()
})
