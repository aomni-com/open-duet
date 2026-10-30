/* The Recent jobs panel lists the same conversations Work's sidebar does, so it
   says what each one is doing in the same marks (`ChatMarks`): live blue for
   running, the ask tone for waiting on you, the unread hue for unread, and
   nothing for work that is done. It used to keep a palette of its own, and a
   done job was green here while the sidebar drew it bare. */
import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { SessionListItem } from '@repo/contract'

import { WorkJobRow } from './work-job-row'

function job(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'job-1',
    title: 'Publish the customer export summary',
    bucket: 'done',
    updatedAt: 1,
    unread: false,
    ...over,
  } as SessionListItem
}

function render(item: SessionListItem): string {
  return renderToStaticMarkup(
    <WorkJobRow job={item} ownerName="Milo" unreadLabel="Unread" onOpen={() => {}} />,
  )
}

test('a running job wears the live mark', () => {
  const html = render(job({ bucket: 'running' }))
  expect(html).toContain('data-chat-state="running"')
  expect(html).toContain('data-tone="live"')
})

test('a job waiting on the reader wears the ask mark', () => {
  const html = render(job({ bucket: 'asking' }))
  expect(html).toContain('data-chat-state="asking"')
  expect(html).toContain('data-tone="alert"')
})

test('a finished job wears nothing, and no hue of its own', () => {
  const html = render(job())
  expect(html).not.toContain('data-chat-state=')
  expect(html).not.toMatch(/emerald|violet|amber|bg-brand/)
})

test('an unread job says so in the unread hue', () => {
  const html = render(job({ unread: true }))
  expect(html).toContain('data-unread=""')
  expect(html).toContain('bg-unread')
})

test('the row names the agent the job belongs to', () => {
  expect(render(job())).toContain('Milo')
})
