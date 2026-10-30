/* Work's chat list says what each conversation is doing now, in the same marks
   Build's roster uses for an agent's own chat. A chat that is working and a
   chat that is resting must not look alike, and "unread" wears its own hue
   (the map's amber), never the blue that means "running". */
import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { SessionListItem } from '@repo/contract'

import { WorkConversationRow } from './work-conversation-row'

function chat(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session-1',
    title: 'Audit production API latency',
    bucket: 'done',
    updatedAt: 1,
    unread: false,
    ...over,
  } as SessionListItem
}

function render(item: SessionListItem, active = false): string {
  return renderToStaticMarkup(
    <WorkConversationRow chat={item} active={active} unreadLabel="Unread" onOpen={() => {}} />,
  )
}

test('a chat that is working says so', () => {
  const html = render(chat({ bucket: 'running' }))
  expect(html).toContain('data-chat-state="running"')
  expect(html).toContain('data-tone="live"')
})

test('a chat waiting on the reader says so in the alert tone', () => {
  const html = render(chat({ bucket: 'asking' }))
  expect(html).toContain('data-chat-state="asking"')
  expect(html).toContain('data-tone="alert"')
})

test('an unread chat wears the unread mark in the unread hue, not the running colour', () => {
  const html = render(chat({ unread: true }))
  expect(html).toContain('data-unread=""')
  expect(html).toMatch(/data-unread=""[^>]*bg-unread|bg-unread[^>]*data-unread=""/)
  expect(html).not.toContain('data-chat-state=')
  expect(html).not.toContain('bg-brand')
})

test('a finished, read chat wears no mark at all', () => {
  const html = render(chat())
  expect(html).not.toContain('data-unread=""')
  expect(html).not.toContain('data-chat-state=')
})

test('a working chat that is also unread carries both marks', () => {
  const html = render(chat({ bucket: 'running', unread: true }))
  expect(html).toContain('data-unread=""')
  expect(html).toContain('data-chat-state="running"')
})
